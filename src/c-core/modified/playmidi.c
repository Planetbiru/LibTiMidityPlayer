/* libTiMidity is licensed under the terms of the GNU Lesser General
 * Public License: see COPYING for details.
 *
 * Note that the included TiMidity source, based on timidity-0.2i, was
 * originally licensed under the GPL, but the author extended it so it
 * can also be used separately under the GNU LGPL or the Perl Artistic
 * License: see the notice by Tuukka Toivonen as it appears on the web
 * at http://ieee.uwaterloo.ca/sca/www.cgs.fi/tt/timidity/ .
 */

/*
 * TiMidity -- Experimental MIDI to WAVE converter
 * Copyright (C) 1995 Tuukka Toivonen <toivonen@clinet.fi>
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or (at
 * your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * playmidi.c -- random stuff in need of rearrangement
 */

#ifdef HAVE_CONFIG_H
#include "config.h"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "timidity.h"
#include "timidity_internal.h"
#include "options.h"
#include "instrum.h"
#include "playmidi.h"
#include "output.h"
#include "mix.h"
#include "tables.h"
#include "readmidi.h"
#include "instrum.h"

static void adjust_amplification(MidSong *song)
{
  song->master_volume = (float)(song->amplification) / 100.0f;
}

static void reset_voices(MidSong *song)
{
  int i;
  for (i=0; i<MID_MAX_VOICES; i++)
    song->voice[i].status=VOICE_FREE;
}
static void kill_note(MidSong *song, int i);

static int find_free_voice(MidSong *song, MidEvent *e)
{
    int i = song->voices, lowest = -1;
    sint32 lv = 0x7FFFFFFF, v;

    while (i--)
    {
        if (song->voice[i].status == VOICE_FREE)
            return i; /* Found a free voice. */

        if (song->voice[i].channel == e->channel && (song->voice[i].note == e->a || song->channel[song->voice[i].channel].mono))
        {
            kill_note(song, i);
            return i; /* Use the voice we just killed */
        }
    }
    return -1; /* No voice available */
}

static void clear_channel_effect_buffers(MidSong *song, int channel,
                                         int clear_reverb, int clear_chorus);
static sint32 effect_tail_limit(MidSong *song, int channel);
static void refresh_effect_tail_remaining(MidSong *song);

/* Process the Reset All Controllers event */
static void reset_controllers(MidSong *song, int c)
{
  int clear_effects = song->channel[c].reverb_send || song->channel[c].chorus_send;
  song->channel[c].volume=90; /* Some standard says, although the SCC docs say 0. */
  song->channel[c].expression=127; /* SCC-1 does this. */
  song->channel[c].sustain=0;
  song->channel[c].pitchbend=0x2000;
  song->channel[c].pitchfactor=0; /* to be computed */
  song->channel[c].reverb_send=0;
  song->channel[c].chorus_send=0;
  if (clear_effects)
    clear_channel_effect_buffers(song, c, 1, 1);
  song->channel_effect_tail_remaining[c] = 0;
  refresh_effect_tail_remaining(song);
}

static void reset_midi(MidSong *song)
{
  int i;
  for (i=0; i<16; i++)
    {
      reset_controllers(song, i);
      /* The rest of these are unaffected by the Reset All Controllers event */
      song->channel[i].program=song->default_program;
      song->channel[i].panning=NO_PANNING;
      song->channel[i].pitchsens=2;
      song->channel[i].bank=0; /* tone bank or drum set */
    }
  reset_voices(song);
}

static void clear_channel_effect_buffers(MidSong *song, int channel,
                                         int clear_reverb, int clear_chorus)
{
  int side, comb;
  for (side = 0; side < 2; side++)
    {
      if (clear_reverb)
        for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
          {
            if (song->reverb_buffer[channel][side][comb])
              memset(song->reverb_buffer[channel][side][comb], 0,
                     song->reverb_buffer_length[channel][comb] * sizeof(float));
            song->reverb_buffer_position[channel][side][comb] = 0;
          }
      if (clear_chorus && song->chorus_buffer[channel][side] && song->chorus_buffer_length)
        memset(song->chorus_buffer[channel][side], 0,
               song->chorus_buffer_length * sizeof(float));
    }
  if (clear_chorus)
    {
      song->chorus_buffer_position[channel] = 0;
      song->chorus_phase[channel] = 0.0;
    }
}

static int ensure_effect_buffers(MidSong *song, int channel)
{
  static const float reverb_delay_seconds[MID_REVERB_COMB_COUNT] = {
    0.0297f, 0.0371f, 0.0411f, 0.0437f
  };
  float *reverb_buffers[2][MID_REVERB_COMB_COUNT] = {{0}};
  float *chorus_buffers[2] = {0, 0};
  uint32 reverb_lengths[MID_REVERB_COMB_COUNT] = {0};
  uint32 chorus_length = (uint32)(song->rate * 0.05f) + 4;
  int side, comb;

  if (channel < 0 || channel >= 16)
    return 0;
  if (song->effect_buffers_allocated[channel])
    return 1;
  if (!song->chorus_lfo_initialized)
    {
      const double two_pi = 6.28318530717958647692;
      int i;
      for (i = 0; i < MID_CHORUS_LFO_TABLE_SIZE; i++)
        song->chorus_lfo_table[i] =
          (float)sin(two_pi * i / MID_CHORUS_LFO_TABLE_SIZE);
      song->chorus_lfo_initialized = 1;
    }
  if (!song->channel_buffer)
    {
      song->channel_buffer = (sint32 *)timi_calloc(song->buffer_size * 2, sizeof(sint32));
      if (!song->channel_buffer)
        return 0;
    }

  for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
    reverb_lengths[comb] = (uint32)(song->rate * reverb_delay_seconds[comb]) + 1;
  for (side = 0; side < 2; side++)
    {
      for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
        {
          reverb_buffers[side][comb] =
            (float *)timi_calloc(reverb_lengths[comb], sizeof(float));
          if (!reverb_buffers[side][comb])
            goto fail;
        }
      chorus_buffers[side] = (float *)timi_calloc(chorus_length, sizeof(float));
      if (!chorus_buffers[side])
        goto fail;
    }

  for (side = 0; side < 2; side++)
    {
      for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
        song->reverb_buffer[channel][side][comb] = reverb_buffers[side][comb];
      song->chorus_buffer[channel][side] = chorus_buffers[side];
    }
  for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
    song->reverb_buffer_length[channel][comb] = reverb_lengths[comb];
  song->chorus_buffer_length = chorus_length;
  song->effect_buffers_allocated[channel] = 1;
  return 1;

fail:
  for (side = 0; side < 2; side++)
    {
      for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
        timi_free(reverb_buffers[side][comb]);
      timi_free(chorus_buffers[side]);
    }
  return 0;
}

int mid_song_prepare_effects(MidSong *song, int channel)
{
  return song && ensure_effect_buffers(song, channel);
}

void mid_song_free_effects(MidSong *song)
{
  int channel, side, comb;
  if (!song)
    return;

  for (channel = 0; channel < 16; channel++)
    {
      for (side = 0; side < 2; side++)
        {
          for (comb = 0; comb < MID_REVERB_COMB_COUNT; comb++)
            {
              timi_free(song->reverb_buffer[channel][side][comb]);
              song->reverb_buffer[channel][side][comb] = NULL;
              song->reverb_buffer_position[channel][side][comb] = 0;
            }
          timi_free(song->chorus_buffer[channel][side]);
          song->chorus_buffer[channel][side] = NULL;
        }
      song->effect_buffers_allocated[channel] = 0;
      song->chorus_buffer_position[channel] = 0;
      song->chorus_phase[channel] = 0.0;
      song->channel_effect_tail_remaining[channel] = 0;
    }
  timi_free(song->channel_buffer);
  song->channel_buffer = NULL;
  song->chorus_buffer_length = 0;
  song->effect_tail_remaining = 0;
}

static void reset_song_effects(MidSong *song)
{
  int channel;
  for (channel = 0; channel < 16; channel++)
    {
      clear_channel_effect_buffers(song, channel, 1, 1);
      song->channel_effect_tail_remaining[channel] = 0;
    }
  song->effect_tail_remaining = 0;
}

static sint32 effect_tail_limit(MidSong *song, int channel)
{
  if (channel < 0 || channel >= 16)
    return 0;
  if (song->channel[channel].reverb_send)
    return song->rate * 2;
  if (song->channel[channel].chorus_send)
    return (sint32)(song->rate * 0.12f);
  return 0;
}

static void refresh_effect_tail_remaining(MidSong *song)
{
  int channel;
  song->effect_tail_remaining = 0;
  for (channel = 0; channel < 16; channel++)
    if (song->channel_effect_tail_remaining[channel] > song->effect_tail_remaining)
      song->effect_tail_remaining = song->channel_effect_tail_remaining[channel];
}

int mid_song_set_channel_effects(MidSong *song, int channel, int reverb, int chorus)
{
  MidChannel *state;
  int previous_reverb, previous_chorus;
  sint32 tail_limit;
  if (!song || channel < 0 || channel >= 16 ||
      reverb < 0 || reverb > 127 || chorus < 0 || chorus > 127)
    return 0;
  if ((reverb || chorus) && !ensure_effect_buffers(song, channel))
    return 0;

  state = &song->channel[channel];
  previous_reverb = state->reverb_send;
  previous_chorus = state->chorus_send;
  if (!reverb && previous_reverb)
    clear_channel_effect_buffers(song, channel, 1, 0);
  if (!chorus && previous_chorus)
    clear_channel_effect_buffers(song, channel, 0, 1);
  state->reverb_send = reverb;
  state->chorus_send = chorus;

  tail_limit = effect_tail_limit(song, channel);
  if (!tail_limit || song->channel_effect_tail_remaining[channel] > tail_limit)
    song->channel_effect_tail_remaining[channel] = tail_limit;
  refresh_effect_tail_remaining(song);
  return 1;
}

int mid_song_set_channel_reverb(MidSong *song, int channel, int reverb)
{
  if (!song || channel < 0 || channel >= 16)
    return 0;
  return mid_song_set_channel_effects(song, channel, reverb,
                                     song->channel[channel].chorus_send);
}

int mid_song_set_channel_chorus(MidSong *song, int channel, int chorus)
{
  if (!song || channel < 0 || channel >= 16)
    return 0;
  return mid_song_set_channel_effects(song, channel,
                                     song->channel[channel].reverb_send,
                                     chorus);
}

int mid_song_set_effects(MidSong *song, int reverb, int chorus)
{
  int channel;
  if (!song || reverb < 0 || reverb > 127 || chorus < 0 || chorus > 127)
    return 0;
  if (reverb || chorus)
    for (channel = 0; channel < 16; channel++)
      if (!ensure_effect_buffers(song, channel))
        return 0;
  for (channel = 0; channel < 16; channel++)
    if (!mid_song_set_channel_effects(song, channel, reverb, chorus))
      return 0;
  return 1;
}

static float chorus_lfo_value(MidSong *song, int channel)
{
  const float two_pi = 6.28318530717958647692f;
  float table_position = song->chorus_phase[channel] *
                         (MID_CHORUS_LFO_TABLE_SIZE / two_pi);
  uint32 index = (uint32)table_position;
  uint32 next;
  float fraction;
  if (index >= MID_CHORUS_LFO_TABLE_SIZE)
    {
      index = 0;
      table_position = 0.0;
    }
  next = (index + 1) & (MID_CHORUS_LFO_TABLE_SIZE - 1);
  fraction = (float)(table_position - index);
  return song->chorus_lfo_table[index] +
         (song->chorus_lfo_table[next] - song->chorus_lfo_table[index]) * fraction;
}

static void process_song_effects(MidSong *song, int midi_channel,
                                 sint32 *buffer, sint32 count, int channels)
{
  const float two_pi = 6.28318530717958647692f;
  const float comb_feedback = 0.72f;
  const float chorus_depth = song->rate * 0.008f;
  const float chorus_base_delay = song->rate * 0.020f;
  const float chorus_phase_increment = two_pi * 0.8f / song->rate;
  MidChannel *state = &song->channel[midi_channel];
  float chorus_gain = (float)state->chorus_send * (0.35f / 127.0f);
  float reverb_gain = (float)state->reverb_send * (0.25f * 0.45f / 127.0f);
  sint32 frame;
  int side;

  for (frame = 0; frame < count; frame++)
    {
      float output[2];
      float chorus_modulation = chorus_gain
        ? chorus_lfo_value(song, midi_channel)
        : 0.0f;
      for (side = 0; side < channels; side++)
        {
          float dry = (float)buffer[frame * channels + side];
          float processed = dry;
          if (state->chorus_send && song->chorus_buffer[midi_channel][side])
            {
              float delay = chorus_base_delay +
                            chorus_depth * (side ? -chorus_modulation : chorus_modulation);
              float read_position;
              uint32 read_index_a, read_index_b;
              float fraction, delayed;
              uint32 length = song->chorus_buffer_length;
              uint32 write_position = song->chorus_buffer_position[midi_channel];

              song->chorus_buffer[midi_channel][side][write_position] = dry;
              read_position = (float)write_position + length - delay;
              if (read_position >= length)
                read_position -= length;
              read_index_a = (uint32)read_position;
              read_index_b = read_index_a + 1;
              if (read_index_b >= length)
                read_index_b = 0;
              fraction = (float)(read_position - read_index_a);
              delayed = song->chorus_buffer[midi_channel][side][read_index_a] * (1.0f - fraction) +
                        song->chorus_buffer[midi_channel][side][read_index_b] * fraction;
              processed += delayed * chorus_gain;
            }

          if (state->reverb_send)
            {
              float reverb_sum = 0.0f;
              uint32 position, length;
              float delayed;

              position = song->reverb_buffer_position[midi_channel][side][0];
              length = song->reverb_buffer_length[midi_channel][0];
              delayed = song->reverb_buffer[midi_channel][side][0][position];
              song->reverb_buffer[midi_channel][side][0][position] =
                processed + delayed * comb_feedback;
              song->reverb_buffer_position[midi_channel][side][0] =
                position + 1 >= length ? 0 : position + 1;
              reverb_sum += delayed;

              position = song->reverb_buffer_position[midi_channel][side][1];
              length = song->reverb_buffer_length[midi_channel][1];
              delayed = song->reverb_buffer[midi_channel][side][1][position];
              song->reverb_buffer[midi_channel][side][1][position] =
                processed + delayed * comb_feedback;
              song->reverb_buffer_position[midi_channel][side][1] =
                position + 1 >= length ? 0 : position + 1;
              reverb_sum += delayed;

              position = song->reverb_buffer_position[midi_channel][side][2];
              length = song->reverb_buffer_length[midi_channel][2];
              delayed = song->reverb_buffer[midi_channel][side][2][position];
              song->reverb_buffer[midi_channel][side][2][position] =
                processed + delayed * comb_feedback;
              song->reverb_buffer_position[midi_channel][side][2] =
                position + 1 >= length ? 0 : position + 1;
              reverb_sum += delayed;

              position = song->reverb_buffer_position[midi_channel][side][3];
              length = song->reverb_buffer_length[midi_channel][3];
              delayed = song->reverb_buffer[midi_channel][side][3][position];
              song->reverb_buffer[midi_channel][side][3][position] =
                processed + delayed * comb_feedback;
              song->reverb_buffer_position[midi_channel][side][3] =
                position + 1 >= length ? 0 : position + 1;
              reverb_sum += delayed;

              processed += reverb_sum * reverb_gain;
            }
          output[side] = processed;
        }

      for (side = 0; side < channels; side++)
        {
          double sample = output[side];
          if (sample > 2147483647.0)
            sample = 2147483647.0;
          else if (sample < -2147483648.0)
            sample = -2147483648.0;
          buffer[frame * channels + side] = (sint32)sample;
        }

      if (state->chorus_send && song->chorus_buffer_length)
        {
          song->chorus_buffer_position[midi_channel]++;
          if (song->chorus_buffer_position[midi_channel] >= song->chorus_buffer_length)
            song->chorus_buffer_position[midi_channel] = 0;
          song->chorus_phase[midi_channel] += chorus_phase_increment;
          if (song->chorus_phase[midi_channel] >= two_pi)
            song->chorus_phase[midi_channel] -= two_pi;
        }
    }
}

static void select_sample(MidSong *song, int v, MidInstrument *ip)
{
  sint32 f, cdiff, diff;
  int s,i;
  MidSample *sp, *closest;

  s=ip->samples;
  sp=ip->sample;

  if (s==1)
    {
      song->voice[v].sample=sp;
      return;
    }

  f=song->voice[v].orig_frequency;
  for (i=0; i<s; i++, sp++)
    {
      if (sp->low_freq <= f && sp->high_freq >= f)
	{
	  song->voice[v].sample=sp;
	  return;
	}
    }

  /*
     No suitable sample found! We'll select the sample whose root
     frequency is closest to the one we want. (Actually we should
     probably convert the low, high, and root frequencies to MIDI
     note values and compare those.)
   */
  cdiff=0x7FFFFFFF;
  closest=sp=ip->sample;
  for(i=0; i<s; i++, sp++)
    {
      diff=sp->root_freq - f;
      if (diff<0) diff=-diff;
      if (diff<cdiff)
	{
	  cdiff=diff;
	  closest=sp;
	}
    }
  song->voice[v].sample=closest;
}

static void recompute_freq(MidSong *song, int v)
{
  int 
    sign=(song->voice[v].sample_increment < 0), /* for bidirectional loops */
    pb=song->channel[song->voice[v].channel].pitchbend;
  double a;

  if (!song->voice[v].sample->sample_rate)
    return;

  if (song->voice[v].vibrato_control_ratio)
    {
      /* This instrument has vibrato. Invalidate any precomputed
         sample_increments. */

      int i=MID_VIBRATO_SAMPLE_INCREMENTS;
      while (i--)
	song->voice[v].vibrato_sample_increment[i]=0;
    }

  if (pb==0x2000 || pb<0 || pb>0x3FFF)
    song->voice[v].frequency = song->voice[v].orig_frequency;
  else
    {
      pb-=0x2000;
      if (!(song->channel[song->voice[v].channel].pitchfactor))
	{
	  /* Damn. Somebody bent the pitch. */
	  sint32 i=pb*song->channel[song->voice[v].channel].pitchsens;
	  if (pb<0)
	    i=-i;
	  song->channel[song->voice[v].channel].pitchfactor=
	    (float)(bend_fine[(i>>5) & 0xFF] * bend_coarse[i>>13]);
	}
      if (pb>0)
	song->voice[v].frequency=
	  (sint32)(song->channel[song->voice[v].channel].pitchfactor *
		  (double)(song->voice[v].orig_frequency));
      else
	song->voice[v].frequency=
	  (sint32)((double)(song->voice[v].orig_frequency) /
		  song->channel[song->voice[v].channel].pitchfactor);
    }

  a = TIM_FSCALE(((double)(song->voice[v].sample->sample_rate) *
		  (double)(song->voice[v].frequency)) /
		 ((double)(song->voice[v].sample->root_freq) *
		  (double)(song->rate)),
		 FRACTION_BITS);

  if (sign)
    a = -a; /* need to preserve the loop direction */

  song->voice[v].sample_increment = (sint32)(a);
}

static void recompute_amp(MidSong *song, int v)
{
  sint32 tempamp;

  /* TODO: use fscale */

  tempamp= (song->voice[v].velocity *
	    song->channel[song->voice[v].channel].volume * 
	    song->channel[song->voice[v].channel].expression); /* 21 bits */

  if (!(song->encoding & PE_MONO))
    {
      if (!song->voice[v].pan_ramp_remaining &&
	  song->voice[v].panning > 60 && song->voice[v].panning < 68)
	{
	  song->voice[v].panned=PANNED_CENTER;

	  song->voice[v].left_amp=
	    TIM_FSCALENEG((double)(tempamp) * song->voice[v].sample->volume * song->master_volume,
			  21);
	}
      else if (!song->voice[v].pan_ramp_remaining &&
	       song->voice[v].panning<5)
	{
	  song->voice[v].panned = PANNED_LEFT;

	  song->voice[v].left_amp=
	    TIM_FSCALENEG((double)(tempamp) * song->voice[v].sample->volume * song->master_volume,
			  20);
	}
      else if (!song->voice[v].pan_ramp_remaining &&
	       song->voice[v].panning>123)
	{
	  song->voice[v].panned = PANNED_RIGHT;

	  song->voice[v].left_amp= /* left_amp will be used */
	    TIM_FSCALENEG((double)(tempamp) * song->voice[v].sample->volume * song->master_volume,
			  20);
	}
      else
	{
	  song->voice[v].panned = PANNED_MYSTERY;

	  song->voice[v].left_amp=
	    TIM_FSCALENEG((double)(tempamp) * song->voice[v].sample->volume * song->master_volume,
			  27);
	  song->voice[v].right_amp = song->voice[v].left_amp * (song->voice[v].panning);
	  song->voice[v].left_amp *= (float)(127 - song->voice[v].panning);
	}
    }
  else
    {
      song->voice[v].panned = PANNED_CENTER;

      song->voice[v].left_amp=
	TIM_FSCALENEG((double)(tempamp) * song->voice[v].sample->volume * song->master_volume,
		      21);
    }
}

static void start_note(MidSong *song, MidEvent *e, int i)
{
  MidInstrument *ip;
  int j;

  if (ISDRUMCHANNEL(song, e->channel))
    {
      if (!(ip=song->drumset[song->channel[e->channel].bank]->instrument[e->a]))
	{
	  if (!(ip=song->drumset[0]->instrument[e->a]))
	    return; /* No instrument? Then we can't play. */
	}
      if (ip->samples != 1)
	{
	  DEBUG_MSG("Strange: percussion instrument with %d samples!\n",
		  ip->samples);
	}

      if (ip->sample->note_to_use) /* Do we have a fixed pitch? */
	song->voice[i].orig_frequency = freq_table[(int)(ip->sample->note_to_use)];
      else
	song->voice[i].orig_frequency = freq_table[e->a & 0x7F];

      /* drums are supposed to have only one sample */
      song->voice[i].sample = ip->sample;
    }
  else
    {
      if (song->channel[e->channel].program == SPECIAL_PROGRAM)
	ip=song->default_instrument;
      else if (!(ip=song->tonebank[song->channel[e->channel].bank]->
		 instrument[song->channel[e->channel].program]))
	{
	  if (!(ip=song->tonebank[0]->instrument[song->channel[e->channel].program]))
	    return; /* No instrument? Then we can't play. */
	}

      if (ip->sample->note_to_use) /* Fixed-pitch instrument? */
	song->voice[i].orig_frequency = freq_table[(int)(ip->sample->note_to_use)];
      else {
        int note = e->a;
        if (song->transpose_semitones != 0) {
          note += song->transpose_semitones;
          if (note < 0) note = 0;
          if (note > 127) note = 127;
        }
	song->voice[i].orig_frequency = freq_table[note & 0x7F];
      }
      select_sample(song, i, ip);
    }

  song->voice[i].status = VOICE_ON;
  song->voice[i].channel = e->channel;
  song->voice[i].track = e->track;
  song->voice[i].note = e->a;
  song->voice[i].velocity = e->b;
  song->voice[i].pan_ramp_remaining = 0;
  song->voice[i].sample_offset = 0;
  song->voice[i].sample_increment = 0; /* make sure it isn't negative */

  song->voice[i].tremolo_phase = 0;
  song->voice[i].tremolo_phase_increment = song->voice[i].sample->tremolo_phase_increment;
  song->voice[i].tremolo_sweep = song->voice[i].sample->tremolo_sweep_increment;
  song->voice[i].tremolo_sweep_position = 0;

  song->voice[i].vibrato_sweep = song->voice[i].sample->vibrato_sweep_increment;
  song->voice[i].vibrato_sweep_position = 0;
  song->voice[i].vibrato_control_ratio = song->voice[i].sample->vibrato_control_ratio;
  song->voice[i].vibrato_control_counter = song->voice[i].vibrato_phase = 0;
  for (j=0; j<MID_VIBRATO_SAMPLE_INCREMENTS; j++)
    song->voice[i].vibrato_sample_increment[j] = 0;

  if (song->channel[e->channel].panning != NO_PANNING)
    song->voice[i].panning = song->channel[e->channel].panning;
  else
    song->voice[i].panning = song->voice[i].sample->panning;

  recompute_freq(song, i);
  recompute_amp(song, i);
  if (song->voice[i].sample->modes & MODES_ENVELOPE)
    {
      /* Ramp up from 0 */
      song->voice[i].envelope_stage = 0;
      song->voice[i].envelope_volume = 0;
      song->voice[i].control_counter = 0;
      recompute_envelope(song, i);
      apply_envelope_to_amp(song, i);
    }
  else
    {
      song->voice[i].envelope_increment = 0;
      apply_envelope_to_amp(song, i);
    }
}

static void kill_note(MidSong *song, int i)
{
  song->voice[i].status = VOICE_DIE;
}

/* Only one instance of a note can be playing on a single channel. */
static void note_on(MidSong *song)
{
  int i = song->voices, lowest=-1;
  sint32 lv=0x7FFFFFFF, v;
  MidEvent *e = song->current_event;

  if (song->channel_mute & (1 << e->channel))
    return;

  if (e->track < 256 && song->track_mute[e->track])
    return;

  while (i--)
    {
      if (song->voice[i].status == VOICE_FREE)
	lowest=i; /* Can't get a lower volume than silence */
      else if (song->voice[i].channel==e->channel && 
	       (song->voice[i].note==e->a || song->channel[song->voice[i].channel].mono))
	kill_note(song, i);
    }

  if (lowest != -1)
    {
      /* Found a free voice. */
      start_note(song,e,lowest);
      return;
    }

  /* Look for the decaying note with the lowest volume */
  i = song->voices;
  while (i--)
    {
      if ((song->voice[i].status != VOICE_ON) &&
	  (song->voice[i].status != VOICE_DIE))
	{
	  v = song->voice[i].left_mix;
	  if ((song->voice[i].panned == PANNED_MYSTERY)
	      && (song->voice[i].right_mix > v))
	    v = song->voice[i].right_mix;
	  if (v<lv)
	    {
	      lv=v;
	      lowest=i;
	    }
	}
    }

  if (lowest != -1)
    {
      /* This can still cause a click, but if we had a free voice to
	 spare for ramping down this note, we wouldn't need to kill it
	 in the first place... Still, this needs to be fixed. Perhaps
	 we could use a reserve of voices to play dying notes only. */

      song->cut_notes++;
      song->voice[lowest].status=VOICE_FREE;
      start_note(song,e,lowest);
    }
  else
    song->lost_notes++;
}

static void finish_note(MidSong *song, int i)
{
  if (song->voice[i].sample->modes & MODES_ENVELOPE)
    {
      /* We need to get the envelope out of Sustain stage */
      song->voice[i].envelope_stage = 3;
      song->voice[i].status = VOICE_OFF;
      recompute_envelope(song, i);
      apply_envelope_to_amp(song, i);
    }
  else
    {
      /* Set status to OFF so resample_voice() will let this voice out
	 of its loop, if any. In any case, this voice dies when it
	 hits the end of its data (ofs>=data_length). */
      song->voice[i].status = VOICE_OFF;
    }
}

static void note_off(MidSong *song)
{
  int i = song->voices;
  MidEvent *e = song->current_event;

  while (i--)
    if (song->voice[i].status == VOICE_ON &&
	song->voice[i].channel == e->channel &&
	song->voice[i].note == e->a)
      {
	if (song->channel[e->channel].sustain)
	  {
	    song->voice[i].status = VOICE_SUSTAINED;
	  }
	else
	  finish_note(song, i);
	return;
      }
}

/* Process the All Notes Off event */
static void all_notes_off(MidSong *song)
{
  int i = song->voices;
  int c = song->current_event->channel;

  DEBUG_MSG("All notes off on channel %d\n", c);
  while (i--)
    if (song->voice[i].status == VOICE_ON &&
	song->voice[i].channel == c)
      {
	if (song->channel[c].sustain) 
	  song->voice[i].status = VOICE_SUSTAINED;
	else
	  finish_note(song, i);
      }
}

/* Process the All Sounds Off event */
static void all_sounds_off(MidSong *song)
{
  int i = song->voices;
  int c = song->current_event->channel;

  while (i--)
    if (song->voice[i].channel == c && 
	song->voice[i].status != VOICE_FREE &&
	song->voice[i].status != VOICE_DIE)
      {
	kill_note(song, i);
      }
}

static void adjust_pressure(MidSong *song)
{
  MidEvent *e = song->current_event;
  int i = song->voices;

  while (i--)
    if (song->voice[i].status == VOICE_ON &&
	song->voice[i].channel == e->channel &&
	song->voice[i].note == e->a)
      {
	song->voice[i].velocity = e->b;
	recompute_amp(song, i);
	apply_envelope_to_amp(song, i);
	return;
      }
}

static void drop_sustain(MidSong *song)
{
  int i = song->voices;
  int c = song->current_event->channel;

  while (i--)
    if (song->voice[i].status == VOICE_SUSTAINED && song->voice[i].channel == c)
      finish_note(song, i);
}

static void adjust_pitchbend(MidSong *song)
{
  int c = song->current_event->channel;
  int i = song->voices;

  while (i--)
    if (song->voice[i].status != VOICE_FREE && song->voice[i].channel == c)
      {
	recompute_freq(song, i);
      }
}

static void adjust_volume(MidSong *song)
{
  int c = song->current_event->channel;
  int i = song->voices;

  while (i--)
    if (song->voice[i].channel == c &&
	(song->voice[i].status==VOICE_ON || song->voice[i].status==VOICE_SUSTAINED))
      {
	recompute_amp(song, i);
	apply_envelope_to_amp(song, i);
      }
}

static void adjust_panning(MidSong *song)
{
  int c = song->current_event->channel;
  int i = song->voices;

  while (i--)
    if (song->voice[i].channel == c &&
	song->voice[i].status != VOICE_FREE &&
	song->voice[i].status != VOICE_DIE)
      {
	switch (song->voice[i].panned)
	  {
	  case PANNED_CENTER:
	    song->voice[i].right_mix = song->voice[i].left_mix;
	    break;
	  case PANNED_LEFT:
	    song->voice[i].right_mix = 0;
	    break;
	  case PANNED_RIGHT:
	    song->voice[i].right_mix = song->voice[i].left_mix;
	    song->voice[i].left_mix = 0;
	    break;
	  }
	song->voice[i].panned = PANNED_MYSTERY;
	song->voice[i].panning = song->channel[c].panning;
	song->voice[i].pan_ramp_remaining = song->rate * 3 / 20;
	if (song->voice[i].pan_ramp_remaining < 1)
	  song->voice[i].pan_ramp_remaining = 1;
	song->voice[i].pan_ramp_duration =
	  song->voice[i].pan_ramp_remaining;
	song->voice[i].left_mix_start = song->voice[i].left_mix;
	song->voice[i].right_mix_start = song->voice[i].right_mix;
	recompute_amp(song, i);
	apply_envelope_to_amp(song, i);
      }
}

static void seek_forward(MidSong *song, sint32 until_time)
{
  reset_voices(song);
  while (song->current_event->time < until_time)
    {
      switch(song->current_event->type)
	{
	  /* All notes stay off. Just handle the parameter changes. */

	case ME_PITCH_SENS:
	  song->channel[song->current_event->channel].pitchsens =
	    song->current_event->a;
	  song->channel[song->current_event->channel].pitchfactor = 0;
	  break;

	case ME_PITCHWHEEL:
	  song->channel[song->current_event->channel].pitchbend =
	    song->current_event->a + song->current_event->b * 128;
	  song->channel[song->current_event->channel].pitchfactor = 0;
	  break;

	case ME_MAINVOLUME:
	  song->channel[song->current_event->channel].volume =
	    song->current_event->a;
	  break;

	case ME_PAN:
	  song->channel[song->current_event->channel].panning =
	    song->current_event->a;
	  break;

	case ME_EXPRESSION:
	  song->channel[song->current_event->channel].expression =
	    song->current_event->a;
	  break;

	case ME_PROGRAM:
	  if (ISDRUMCHANNEL(song, song->current_event->channel))
	    /* Change drum set */
	    song->channel[song->current_event->channel].bank =
	      song->current_event->a;
	  else
	    song->channel[song->current_event->channel].program =
	      song->current_event->a;
	  break;

	case ME_SUSTAIN:
	  song->channel[song->current_event->channel].sustain =
	    song->current_event->a;
	  break;

	case ME_REVERB:
	  mid_song_set_channel_reverb(song, song->current_event->channel,
	                              song->current_event->a);
	  break;

	case ME_CHORUS:
	  mid_song_set_channel_chorus(song, song->current_event->channel,
	                              song->current_event->a);
	  break;

	case ME_RESET_CONTROLLERS:
	  reset_controllers(song, song->current_event->channel);
	  break;

	case ME_TONE_BANK:
	  song->channel[song->current_event->channel].bank =
	    song->current_event->a;
	  break;

	case ME_EOT:
	  song->current_sample = song->current_event->time;
	  return;
	}
      song->current_event++;
    }
  /*song->current_sample=song->current_event->time;*/
  if (song->current_event != song->events)
    song->current_event--;
  song->current_sample=until_time;
}

static void skip_to(MidSong *song, sint32 until_time)
{
  if (song->current_sample > until_time)
    song->current_sample = 0;

  reset_midi(song);
  song->current_event = song->events;
  song->events_finished = 0;
  reset_song_effects(song);

  if (until_time)
    seek_forward(song, until_time);
}

static void do_compute_data(MidSong *song, sint32 count)
{
  int i;
  int channel;
  int any_effect_send = 0;
  int audio_channels = (song->encoding & PE_MONO) ? 1 : 2;
  memset(song->common_buffer, 0, count * audio_channels * 4);
  for (channel = 0; channel < 16; channel++)
    if (song->channel[channel].reverb_send || song->channel[channel].chorus_send)
      any_effect_send = 1;

  if (!any_effect_send)
    {
      for (i = 0; i < song->voices; i++)
        {
          if(song->voice[i].status != VOICE_FREE)
            mix_voice(song, song->common_buffer, i, count);
        }
    }
  else
    {
      for (channel = 0; channel < 16; channel++)
        {
          if (!song->channel[channel].reverb_send &&
              !song->channel[channel].chorus_send)
            {
              for (i = 0; i < song->voices; i++)
                if (song->voice[i].status != VOICE_FREE &&
                    song->voice[i].channel == channel)
                  mix_voice(song, song->common_buffer, i, count);
            }
          else
            {
              int has_channel_voices = 0;
              sint32 sample_count = count * audio_channels;
              memset(song->channel_buffer, 0,
                     sample_count * sizeof(sint32));
              for (i = 0; i < song->voices; i++)
                if (song->voice[i].status != VOICE_FREE &&
                    song->voice[i].channel == channel)
                  {
                    has_channel_voices = 1;
                    mix_voice(song, song->channel_buffer, i, count);
                  }

              if (has_channel_voices ||
                  song->channel_effect_tail_remaining[channel] > 0)
                {
                  process_song_effects(song, channel, song->channel_buffer,
                                       count, audio_channels);
                  if (has_channel_voices)
                    song->channel_effect_tail_remaining[channel] =
                      effect_tail_limit(song, channel);
                  else if (song->channel_effect_tail_remaining[channel] > 0)
                    {
                      song->channel_effect_tail_remaining[channel] -= count;
                      if (song->channel_effect_tail_remaining[channel] < 0)
                        song->channel_effect_tail_remaining[channel] = 0;
                    }
                  for (i = 0; i < sample_count; i++)
                    song->common_buffer[i] += song->channel_buffer[i];
                }
            }
        }
      refresh_effect_tail_remaining(song);
    }

  if (!any_effect_send)
    {
      int c;
      song->effect_tail_remaining = 0;
      for (c = 0; c < 16; c++)
        song->channel_effect_tail_remaining[c] = 0;
    }
    
  /* Master Peak Tracking */
  if (audio_channels == 2) {
      for (i = 0; i < count * 2; i += 2) {
          sint32 val_l = song->common_buffer[i];
          sint32 val_r = song->common_buffer[i+1];
          if (val_l < 0) val_l = -val_l;
          if (val_r < 0) val_r = -val_r;
          if (val_l > song->master_peak_l) song->master_peak_l = val_l;
          if (val_r > song->master_peak_r) song->master_peak_r = val_r;
      }
  } else {
      for (i = 0; i < count; i++) {
          sint32 val = song->common_buffer[i];
          if (val < 0) val = -val;
          if (val > song->master_peak_l) song->master_peak_l = val;
          if (val > song->master_peak_r) song->master_peak_r = val;
      }
  }
    
  song->current_sample += count;
}

/* count=0 means flush remaining buffered data to output device, then
   flush the device itself */
static void compute_data(MidSong *song, sint8 **stream, sint32 count)
{
  int channels;

  if ( song->encoding & PE_MONO )
    channels = 1;
  else
    channels = 2;

  while (count) {
    sint32 block = count;
    if (block > song->buffer_size)
      block = song->buffer_size;
    do_compute_data(song, block);
    song->write(*stream, song->common_buffer, channels * block);
    *stream += song->bytes_per_sample * block;
    count -= block;
  }
}

void mid_song_start(MidSong *song)
{
  song->playing = 1;
  adjust_amplification(song);
  skip_to(song, 0);
}

void mid_song_seek(MidSong *song, uint32 ms)
{
  skip_to(song, (ms * (song->rate / 100)) / 10);
}

uint32 mid_song_get_total_time(MidSong *song)
{
  MidEvent *last_event = &song->events[song->groomed_event_count - 1];
  /* We want last_event->time * 1000 / song->rate */
  uint32 retvalue = (last_event->time / song->rate) * 1000;
  retvalue       += (last_event->time % song->rate) * 1000 / song->rate;
  return retvalue;
}

void mid_song_force_mono_pan(MidSong *song)
{
  int i;
  for (i = 0; i < song->groomed_event_count; i++) {
    if (song->events[i].type == ME_PAN) {
      song->events[i].a = 64;
    }
  }
}

uint32 mid_song_get_time(MidSong *song)
{
  uint32 retvalue = (song->current_sample / song->rate) * 1000;
  retvalue       += (song->current_sample % song->rate) * 1000 / song->rate;
  return retvalue;
}

char *mid_song_get_meta(MidSong *song, MidSongMetaId what)
{
  return (what < 0 || what >= MID_META_MAX)? NULL : song->meta_data[what];
}

size_t mid_song_read_wave(MidSong *song, sint8 *ptr, size_t size, int skip_callback)
{
  sint32 start_sample, end_sample, samples;

  if (!song->playing)
    return 0;

  /* Once the event stream and all release tails are finished, no more audio
     needs to be produced. The final block is returned by the call that
     releases the last voice below. */
  if (song->events_finished && mid_song_get_active_voices(song) == 0 &&
      song->effect_tail_remaining == 0)
    {
      song->playing = 0;
      return 0;
    }

  samples = size / song->bytes_per_sample;

  start_sample = song->current_sample;
  end_sample = song->current_sample+samples;
  do {
    /* Handle all events that should happen at this time */
    while (!song->events_finished &&
           song->current_event->time <= song->current_sample) {
      if (!skip_callback && global_event_callback && song->rate != 0) {
          uint32 current_ms = (uint32)(((uint64)song->current_event->time * 1000) / song->rate);
          uint8 callback_midi_status = song->current_event->midi_event_type;
          uint8 midi_channel     = song->current_event->channel;
          const char *text   = NULL;

          // Meta-event handling
          if (song->current_event->type == ME_TEMPO) {
            callback_midi_status = 0xFF;   // Meta-event
            midi_channel     = 16;    // Non-channel event
          } else if (song->current_event->type == ME_LYRIC) {
            callback_midi_status = 0xFF;   // Meta-event
            midi_channel     = 16;    // Non-channel event
            text = (const char*) song->current_event->a;
          }

          global_event_callback(song->current_event->tick, current_ms,
                        callback_midi_status, midi_channel, song->current_event->type,
                        song->current_event->a, song->current_event->b,
                        text);
      }

      switch(song->current_event->type) {
	/* Effects affecting a single note */
	case ME_NOTEON:
	  if (!(song->current_event->b)) /* Velocity 0? */
	    note_off(song);
	  else
	    note_on(song);
	  break;

	case ME_NOTEOFF:
	  note_off(song);
	  break;

	case ME_KEYPRESSURE:
	  adjust_pressure(song);
	  break;

	/* Effects affecting a single channel */
	case ME_PITCH_SENS:
	  song->channel[song->current_event->channel].pitchsens =
	    song->current_event->a;
	  song->channel[song->current_event->channel].pitchfactor = 0;
	  break;

	case ME_PITCHWHEEL:
	  song->channel[song->current_event->channel].pitchbend =
	    song->current_event->a + song->current_event->b * 128;
	  song->channel[song->current_event->channel].pitchfactor = 0;
	  /* Adjust pitch for notes already playing */
	  adjust_pitchbend(song);
	  break;

	case ME_MAINVOLUME:
	  song->channel[song->current_event->channel].volume =
	    song->current_event->a;
	  adjust_volume(song);
	  break;

	case ME_PAN:
	  song->channel[song->current_event->channel].panning =
	    song->current_event->a;
	  adjust_panning(song);
	  break;

	case ME_EXPRESSION:
	  song->channel[song->current_event->channel].expression =
	    song->current_event->a;
	  adjust_volume(song);
	  break;

	case ME_PROGRAM:
	  if (ISDRUMCHANNEL(song, song->current_event->channel)) {
	    /* Change drum set */
	    song->channel[song->current_event->channel].bank =
	      song->current_event->a;
	  }
	  else
	    song->channel[song->current_event->channel].program =
	      song->current_event->a;
	  break;

	case ME_SUSTAIN:
	  song->channel[song->current_event->channel].sustain =
	    song->current_event->a;
	  if (!song->current_event->a)
	    drop_sustain(song);
	  break;

	case ME_REVERB:
	  mid_song_set_channel_reverb(song, song->current_event->channel,
	                              song->current_event->a);
	  break;

	case ME_CHORUS:
	  mid_song_set_channel_chorus(song, song->current_event->channel,
	                              song->current_event->a);
	  break;

	case ME_RESET_CONTROLLERS:
	  reset_controllers(song, song->current_event->channel);
	  break;

	case ME_ALL_NOTES_OFF:
	  all_notes_off(song);
	  break;

	case ME_ALL_SOUNDS_OFF:
	  all_sounds_off(song);
	  break;

	case ME_TONE_BANK:
	  song->channel[song->current_event->channel].bank =
	    song->current_event->a;
	  break;

	case ME_EOT:
    /* The MIDI event stream is finished, but release tails still need
       audio blocks. Keep rendering until the last voice becomes free. */
	  DEBUG_MSG("Playing time: ~%d seconds\n",
		     song->current_sample/song->rate+2);
	  DEBUG_MSG("Notes cut: %d\n", song->cut_notes);
	  DEBUG_MSG("Notes lost totally: %d\n", song->lost_notes);
	  song->events_finished = 1;
	  break;
        }
      if (!song->events_finished)
        song->current_event++;
    }
    if (song->events_finished)
      compute_data(song, &ptr, end_sample-song->current_sample);
    else if (song->current_event->time > end_sample)
      compute_data(song, &ptr, end_sample-song->current_sample);
    else
      compute_data(song, &ptr, song->current_event->time-song->current_sample);
  } while ( song->current_sample < end_sample );
  if (song->events_finished && mid_song_get_active_voices(song) == 0 &&
      song->effect_tail_remaining == 0)
    song->playing = 0;

  return (song->current_sample - start_sample) * song->bytes_per_sample;
}

void mid_song_set_volume(MidSong *song, int volume)
{
  int i;
  if (volume > MAX_AMPLIFICATION)
    song->amplification = MAX_AMPLIFICATION;
  else
  if (volume < 0)
    song->amplification = 0;
  else
    song->amplification = volume;
  adjust_amplification(song);
  for (i = 0; i < song->voices; i++)
    if (song->voice[i].status != VOICE_FREE)
      {
	recompute_amp(song, i);
	apply_envelope_to_amp(song, i);
      }
}

void mid_song_set_transpose(MidSong *song, int semitones)
{
  if (song) {
    song->transpose_semitones = semitones;
  }
}

void mid_song_set_channel_mute(MidSong *song, int channel, int mute)
{
  if (song && channel >= 0 && channel < 16) {
    if (mute) {
      song->channel_mute |= (1 << channel);
      /* Kill all active notes on this channel immediately */
      int i = song->voices;
      while (i--) {
        if (song->voice[i].status != VOICE_FREE && song->voice[i].channel == channel) {
          song->voice[i].status = VOICE_DIE;
        }
      }
    } else {
      song->channel_mute &= ~(1 << channel);
      /* After unmuting, we need to resend active notes. This ensures that any
       * notes that should be playing on this channel are immediately triggered,
       * avoiding silence until the next note-on event. */
      mid_song_resend_active_notes(song);
    }
  }
}

void mid_song_set_track_mute(MidSong *song, int track, int mute)
{
  if (song && track >= 0 && track < 256) {
    if (mute) {
      song->track_mute[track] = 1;
      /* Kill all active notes on this track immediately */
      int i = song->voices;
      while (i--) {
        if (song->voice[i].status != VOICE_FREE && song->voice[i].track == track) {
          song->voice[i].status = VOICE_DIE;
        }
      }
    } else {
      song->track_mute[track] = 0;
    }
  }
}

void mid_song_panic(MidSong *song)
{
  if (song) {
    int i = song->voices;
    while (i--) {
      if (song->voice[i].status != VOICE_FREE) {
        song->voice[i].status = VOICE_DIE;
      }
    }
  }
}

int mid_song_get_active_voices(MidSong *song)
{
    int active = 0;
    if (song) {
        for (int i = 0; i < song->voices; i++) {
            if (song->voice[i].status != VOICE_FREE) {
                active++;
            }
        }
    }
    return active;
}

int mid_song_get_master_peak(MidSong *song, int channel, int reset)
{
    int peak = 0;
    if (song) {
        peak = (channel == 0) ? song->master_peak_l : song->master_peak_r;
        
        /* Shift down from internal 32-bit mix to 16-bit PCM level */
        peak >>= (32 - 16 - GUARD_BITS);
        
        /* Clamp to roughly 16-bit PCM equivalent peak */
        if (peak > 32767) peak = 32767;
        
        /* Map to 0-127 range */
        peak = (peak * 127) / 32767;
        
        if (reset) {
            if (channel == 0) {
                song->master_peak_l = 0;
            } else {
                song->master_peak_r = 0;
            }
        }
    }
    return peak;
}

int mid_note_on(MidSong *song, int channel, int bank, int program, int note, int velocity, int pan, int bend, int modulation, int sustain)
{
  MidEvent e;
  MidInstrument *ip;
  int i;

  if (!song || !song->playing || channel < 0 || channel >= 16) return -1;
  if (song->channel_mute & (1 << channel)) return -1;

  if (channel == 9) {
    song->drumchannels |= (1 << 9);
  }

  song->channel[channel].panning = pan;
  song->channel[channel].pitchbend = bend;
  song->channel[channel].sustain = sustain;
  song->channel[channel].pitchfactor = 0; /* force recompute */
  song->channel[channel].bank = bank; /* Apply bank */

  if (ISDRUMCHANNEL(song, channel))
  {
    if (!(ip = song->drumset[song->channel[channel].bank]->instrument[note]))
    {
      if (!(ip = song->drumset[0]->instrument[note]))
        return note; /* Return missing drum note (as program) */
    }
  }
  else
  {
    /* Change program if needed */
    if (song->channel[channel].program != program)
    {
      song->channel[channel].program = program;
    }
    if (song->channel[channel].program == SPECIAL_PROGRAM)
      ip = song->default_instrument;
    else if (!(ip = song->tonebank[song->channel[channel].bank]->instrument[song->channel[channel].program]))
    {
      if (!(ip = song->tonebank[0]->instrument[song->channel[channel].program]))
      {
        return program; /* Return missing program number */
      }
      if (!ip)
        return program; /* Return missing program number */
    }
  }

  e.type = ME_NOTEON;
  e.channel = channel;
  e.a = note;
  e.b = velocity;

  /* Find a free voice and start the note */
  i = find_free_voice(song, &e);
  if (i != -1)
  {
    start_note(song, &e, i);
  }
  return 0; /* Success */
}

void mid_note_off(MidSong *song, int channel, int note)
{
  if (!song || !song->playing) return;

  MidEvent e;
  e.type = ME_NOTEOFF;
  e.channel = channel;
  e.a = note;
  e.b = 0; // Velocity for note-off is typically 0

  /* Temporarily set the current_event to our new event */
  MidEvent *original_event = song->current_event;
  song->current_event = &e;
  note_off(song);
  song->current_event = original_event;
}

void mid_send_event(MidSong *song, int type, int channel, int a, int b)
{
  if (!song || !song->playing) return;
  
  MidEvent e;
  e.type = type;
  e.channel = channel;
  e.a = a;
  e.b = b;

  MidEvent *original_event = song->current_event;
  song->current_event = &e;

  switch(e.type) {
    case ME_PITCH_SENS:
      song->channel[channel].pitchsens = a;
      song->channel[channel].pitchfactor = 0;
      break;

    case ME_PITCHWHEEL:
      song->channel[channel].pitchbend = a + b * 128;
      song->channel[channel].pitchfactor = 0;
      adjust_pitchbend(song);
      break;

    case ME_MAINVOLUME:
      song->channel[channel].volume = a;
      adjust_volume(song);
      break;

    case ME_PAN:
      song->channel[channel].panning = a;
      adjust_panning(song);
      break;

    case ME_EXPRESSION:
      song->channel[channel].expression = a;
      adjust_volume(song);
      break;

    case ME_SUSTAIN:
      song->channel[channel].sustain = a;
      if (!a)
        drop_sustain(song);
      break;

    case ME_REVERB:
      mid_song_set_channel_reverb(song, channel, a);
      break;

    case ME_CHORUS:
      mid_song_set_channel_chorus(song, channel, a);
      break;

    case ME_PROGRAM:
      if (ISDRUMCHANNEL(song, channel))
        song->channel[channel].bank = a;
      else
        song->channel[channel].program = a;
      break;
      
    case ME_RESET_CONTROLLERS:
      reset_controllers(song, channel);
      break;
      
    case ME_ALL_NOTES_OFF:
      all_notes_off(song);
      break;

    case ME_ALL_SOUNDS_OFF:
      all_sounds_off(song);
      break;

    case ME_TONE_BANK:
      song->channel[channel].bank = a;
      break;
  }

  song->current_event = original_event;
}

/* Resend all active notes to the event callback.
 * This is useful for UIs that need to refresh their state. */
void mid_song_resend_active_notes(MidSong *song)
{
  int i;
  uint32 current_tick;
  if (!song || !global_event_callback) return;

  current_tick = mid_song_get_current_tick(song);
  for (i = 0; i < song->voices; i++)
  {
    if (song->voice[i].status == VOICE_ON)
    {
      uint32 current_ms = (uint32)(((uint64)song->current_sample * 1000) / song->rate);
      uint8 midi_status_byte = 0x90; // Status for Note On, channel is separate

      global_event_callback(current_tick, current_ms,
                            midi_status_byte, song->voice[i].channel, ME_NOTEON,
                            song->voice[i].note, song->voice[i].velocity, NULL);
    }
  }
}

/*
 * Simulates playback up to a certain tick and returns the value of a specific
 * controller for a given channel. This does not affect the actual playback state.
 * Returns the controller value, or -1 if not found or invalid.
 */
sint32 mid_song_get_controller_value_at_tick(MidSong *song, int channel, int cc, sint32 tick)
{
    if (!song || !song->events || channel < 0 || channel > 15)
    {
        return -1;
    }

    MidEvent *e = song->events;
    MidChannel temp_channel_state;

    /* Initialize a temporary channel state with defaults */
    temp_channel_state.volume = 90;
    temp_channel_state.expression = 127;
    temp_channel_state.sustain = 0;
    temp_channel_state.reverb_send = 0;
    temp_channel_state.chorus_send = 0;
    temp_channel_state.pitchbend = 0x2000;
    temp_channel_state.panning = 64; /* Center panning */
    /* We don't have dedicated fields for other CCs, so we can't track them yet.
       This would require extending the MidChannel struct.
       For now, we will handle the ones that are tracked. */

    /* Iterate through events up to the specified tick */
    while (e->type != ME_EOT && e->time <= tick)
    {
        if (e->channel == channel)
        {
            switch (e->type)
            {
            case ME_MAINVOLUME:
                temp_channel_state.volume = e->a;
                break;
            case ME_PAN:
                temp_channel_state.panning = e->a;
                break;
            case ME_PITCHWHEEL:
                temp_channel_state.pitchbend = e->a + e->b * 128;
                break;
            case ME_EXPRESSION:
                temp_channel_state.expression = e->a;
                break;
            case ME_SUSTAIN:
                temp_channel_state.sustain = e->a;
                break;
            case ME_REVERB:
                temp_channel_state.reverb_send = e->a;
                break;
            case ME_CHORUS:
                temp_channel_state.chorus_send = e->a;
                break;
            case ME_RESET_CONTROLLERS:
                temp_channel_state.volume = 90;
                temp_channel_state.expression = 127;
                temp_channel_state.sustain = 0;
                temp_channel_state.pitchbend = 0x2000;
                temp_channel_state.reverb_send = 0;
                temp_channel_state.chorus_send = 0;
                break;
            /* Other events like modulation, reverb, etc. are not stored in MidChannel struct yet */
            }
        }
        e++;
    }

    /* Return the requested value */
    switch (cc)
    {
    case 7: /* Volume */
        return temp_channel_state.volume;
    case 10: /* Pan */
        return temp_channel_state.panning;
    case 11: /* Expression */
        return temp_channel_state.expression;
    case 64: /* Sustain Pedal */
        return temp_channel_state.sustain;
    case 91: /* Reverb Send */
        return temp_channel_state.reverb_send;
    case 93: /* Chorus Send */
        return temp_channel_state.chorus_send;
    case 256: /* Pitch Bend - Using a custom CC number for this special case */
        return temp_channel_state.pitchbend;
    default:
        /* For other CCs, we would need to extend MidChannel struct */
        return -1; /* Not tracked / supported yet */
    }
}
