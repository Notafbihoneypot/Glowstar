package org.glowstr.meshbridge;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class TrustedWebContentSelfTest {
    private static void check(boolean valid, String message) {
        if (!valid) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        String cap = TrustedWebContent.newCapability();
        check(TrustedWebContent.authorized(cap, cap), "Main frame capability refused");
        check(!TrustedWebContent.authorized(cap, null), "Null capability accepted");
        check(!TrustedWebContent.authorized(cap, ""), "Missing capability accepted");
        check(!TrustedWebContent.authorized(cap, TrustedWebContent.newCapability()), "Another WebView capability accepted");
        for (int i = 0; i < cap.length(); i++) {
            char alternate = cap.charAt(i) == 'a' ? 'b' : 'a';
            check(!TrustedWebContent.authorized(cap, cap.substring(0,i) + alternate + cap.substring(i+1)), "Changed capability accepted");
        }
        check(TrustedWebContent.isAppDocument("https://app.glowstr.local/"), "Bundled document refused");
        check(TrustedWebContent.isAppDocument("https://app.glowstr.local/#keys"), "Local fragment refused");
        for (String url : new String[]{"https://app.glowstr.local/evil", "https://app.glowstr.local/?html=evil",
                "https://app.glowstr.local.evil/", "https://user@app.glowstr.local/", "https://app.glowstr.local:444/",
                "http://app.glowstr.local/", "data:text/html,evil", "blob:https://app.glowstr.local/abc", "about:blank"}) {
            check(!TrustedWebContent.isAppDocument(url), "Untrusted document accepted: " + url);
        }
        Path source = Path.of(args.length > 0 ? args[0] : "glowstr-v5.3-bluetooth-direct.html");
        String bound = TrustedWebContent.bindBridge(Files.readString(source), cap);
        check(bound.contains("frame-src 'none';"), "Remote frames permitted");
        check(bound.contains("window !== window.top"), "Missing top-frame bootstrap gate");
        check(bound.contains("native[name](cap, ...args)"), "Missing capability for native calls");
        Matcher script = Pattern.compile("<script>(.*?)</script>", Pattern.DOTALL).matcher(bound);
        check(script.find(), "Missing bundled script");
        String hash = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(script.group(1).getBytes(StandardCharsets.UTF_8)));
        check(bound.contains("'sha256-" + hash + "'"), "Runtime CSP does not authorize the bound script");
        String other = TrustedWebContent.bindBridge(Files.readString(source), TrustedWebContent.newCapability());
        check(!other.contains(cap), "Launch capability reused");
        if (args.length > 1) Files.writeString(Path.of(args[1]), bound);
        System.out.println("TrustedWebContent: PASS (capability, document policy, frame denial, runtime CSP)");
    }
}
