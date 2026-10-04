package org.glowstr.meshbridge;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Only the bundled main document receives a capability for the legacy sync API. */
final class TrustedWebContent {
    static final String ORIGIN = "https://app.glowstr.local/";
    private static final Pattern SCRIPT = Pattern.compile("<script>(.*?)</script>", Pattern.DOTALL);

    static String newCapability() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static boolean authorized(String expected, String supplied) {
        return expected != null && supplied != null && expected.length() == 43 &&
                MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                        supplied.getBytes(StandardCharsets.UTF_8));
    }

    static boolean isAppDocument(String value) {
        try {
            URI uri = new URI(value);
            return "https".equals(uri.getScheme()) && "app.glowstr.local".equals(uri.getHost()) &&
                    (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null &&
                    "/".equals(uri.getPath()) && uri.getQuery() == null;
        } catch (Exception ignored) { return false; }
    }

    static String bindBridge(String html, String capability) throws Exception {
        if (capability == null || !capability.matches("[A-Za-z0-9_-]{43}"))
            throw new IllegalArgumentException("Invalid bridge capability");
        String bootstrap = "\n(() => {\n" +
                "if (window !== window.top) throw new Error('Main document required');\n" +
                "const native = window.GlowstrNative, cap = '" + capability + "';\n" +
                "const api = Object.create(null);\n" +
                "for (const name of ['notificationsEnabled','notifyNostr','amberSignerAvailable'," +
                "'amberGetPublicKey','amberApproveEvent','pollAmberResult'," +
                "'saveRememberedPublicState','loadRememberedPublicState','clearRememberedPublicState'," +
                "'saveRememberedLocalSigner','loadRememberedLocalSigner','clearRememberedLocalSigner'," +
                "'saveRememberedRemoteSigner','loadRememberedRemoteSigner','clearRememberedRemoteSigner'," +
                "'secureLocalSignerStorageAvailable','startNostrQrScanner','pollNostrQrResult'," +
                "'makeNostrQrDataUrl','pairingToken','openExternal','request']) {\n" +
                "api[name] = (...args) => native[name](cap, ...args);\n" +
                "}\nObject.defineProperty(window, 'GlowstrAndroid', {value:Object.freeze(api)});\n" +
                "delete window.GlowstrNative;\n})();\n";
        Matcher match = SCRIPT.matcher(html);
        if (!match.find() || match.find()) throw new IllegalArgumentException("One bundled script required");
        match.reset(); match.find();
        String script = bootstrap + match.group(1);
        String hash = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(script.getBytes(StandardCharsets.UTF_8)));
        String result = html.substring(0, match.start(1)) + script + html.substring(match.end(1));
        // No remote or inherited document may execute alongside the native API.
        result = result.replaceFirst("frame-src [^;]*;", "frame-src 'none';")
                .replaceFirst("'sha256-[^']+'", "'sha256-" + hash + "'");
        return result;
    }
}
