<?php
declare(strict_types=1);

function timidityPlayerRuntimeForUserAgent(string $userAgent): string
{
    $majorVersion = static function (string $pattern) use ($userAgent): ?int {
        if (preg_match($pattern, $userAgent, $matches) !== 1) {
            return null;
        }

        return (int) $matches[1];
    };

    if (preg_match('/(?:MSIE|Trident\/)/i', $userAgent) === 1) {
        return 'unsupported';
    }

    $edgeVersion = $majorVersion('/(?:EdgA|EdgiOS|Edg|Edge)\/(\d+)/i');
    if ($edgeVersion !== null) {
        return $edgeVersion >= 85 ? 'wasm' : 'asmjs';
    }

    if (preg_match('/(?:CriOS|FxiOS)\//i', $userAgent) === 1) {
        $iosVersion = $majorVersion('/(?:iPhone|iPad|iPod).*?OS (\d+)[._]/i');
        return $iosVersion !== null && $iosVersion >= 15 ? 'wasm' : 'asmjs';
    }

    $operaVersion = $majorVersion('/(?:OPR|Opera)\/(\d+)/i');
    if ($operaVersion !== null) {
        $chromiumVersion = $majorVersion('/Chrome\/(\d+)/i');
        return $chromiumVersion !== null && $chromiumVersion >= 85
            ? 'wasm'
            : 'asmjs';
    }

    $firefoxVersion = $majorVersion('/Firefox\/(\d+)/i');
    if ($firefoxVersion !== null) {
        return $firefoxVersion >= 79 ? 'wasm' : 'asmjs';
    }

    $chromeVersion = $majorVersion('/Chrome\/(\d+)/i');
    if ($chromeVersion !== null) {
        return $chromeVersion >= 85 ? 'wasm' : 'asmjs';
    }

    $safariVersion = $majorVersion('/Version\/(\d+)(?:\.\d+)*.*Safari\//i');
    if ($safariVersion !== null) {
        return $safariVersion >= 15 ? 'wasm' : 'asmjs';
    }

    return 'asmjs';
}

$timidityUserAgent = $_SERVER['HTTP_USER_AGENT'] ?? '';
$timidityPlayerRuntime = timidityPlayerRuntimeForUserAgent($timidityUserAgent);
$timidityAssetBase = isset($timidityAssetBase) ? (string) $timidityAssetBase : './';
$timidityAssetBase = rtrim($timidityAssetBase, '/') . '/';

if ($timidityPlayerRuntime === 'wasm') {
    $scripts = ['timidity-player.wasm.js', 'libtimidity.wasm.js'];
} elseif ($timidityPlayerRuntime === 'asmjs') {
    $scripts = ['timidity-player.js', 'libtimidity.js'];
} else {
    $scripts = [];
}

foreach ($scripts as $script) {
    $src = htmlspecialchars($timidityAssetBase . $script, ENT_QUOTES, 'UTF-8');
    echo '<script src="' . $src . '"></script>' . PHP_EOL;
}

if ($timidityPlayerRuntime === 'unsupported') {
    echo '<!-- This browser is not supported by the configured player builds. -->' . PHP_EOL;
}
