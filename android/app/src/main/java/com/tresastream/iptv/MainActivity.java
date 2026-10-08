package com.tresastream.iptv;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.provider.Settings;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.util.Enumeration;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends BridgeActivity {
    private static ServerSocket localProxyServer = null;
    private static final int LOCAL_PROXY_PORT = 34567;
    private static volatile HttpURLConnection activeStreamConn = null;
    private static volatile Socket activeStreamSocket = null;
    private static volatile String activeTargetUrl = null;
    private static final ConcurrentHashMap<String, String> vodRedirectCache = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBarsAndKeepNavigationFixed();
        configureWebViewForVideoPlayback();
        startLocalStreamProxyServer();
        setupAndroidBackNavigation();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            configureSystemBarsAndKeepNavigationFixed();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        configureSystemBarsAndKeepNavigationFixed();
        startLocalStreamProxyServer();
    }

    private String detectDeviceWifiIpAddress() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface nif = interfaces.nextElement();
                if (nif == null || nif.isLoopback() || !nif.isUp()) continue;
                String name = nif.getName() != null ? nif.getName().toLowerCase() : "";
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        String ip = addr.getHostAddress();
                        if (ip != null && (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.") || name.contains("wlan") || name.contains("eth"))) {
                            return ip;
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
        return "127.0.0.1";
    }

    public class AndroidCastBridge {
        @JavascriptInterface
        public String getWifiLanIp() {
            return detectDeviceWifiIpAddress();
        }

        @JavascriptInterface
        public String getLanProxyBaseUrl() {
            String ip = detectDeviceWifiIpAddress();
            return "http://" + ip + ":" + LOCAL_PROXY_PORT;
        }

        @JavascriptInterface
        public String getCachedRedirectUrl(String rawUrl) {
            if (rawUrl == null) return "";
            String clean = rawUrl.trim().replace(" ", "%20");
            return vodRedirectCache.getOrDefault(clean, clean);
        }

        @JavascriptInterface
        public boolean launchExternalCastIntent(String streamUrl, String title, String mimeType) {
            try {
                if (streamUrl == null || streamUrl.isEmpty()) return false;
                String resolvedMime = (mimeType != null && !mimeType.isEmpty()) ? mimeType : "video/*";
                Intent intent = new Intent(Intent.ACTION_VIEW);
                Uri uri = Uri.parse(streamUrl);
                intent.setDataAndType(uri, resolvedMime);
                if (title != null && !title.isEmpty()) {
                    intent.putExtra("title", title);
                    intent.putExtra(Intent.EXTRA_TITLE, title);
                }
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                Intent chooser = Intent.createChooser(intent, "Transmitir para Chromecast / Smart TV");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(chooser);
                return true;
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent(Intent.ACTION_VIEW, Uri.parse(streamUrl));
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(fallback);
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }
        }

        @JavascriptInterface
        public boolean openSystemCastSettings() {
            try {
                Intent castIntent = new Intent(Settings.ACTION_CAST_SETTINGS);
                castIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(castIntent);
                return true;
            } catch (Exception e) {
                try {
                    Intent wifiDisplay = new Intent("android.settings.WIFI_DISPLAY_SETTINGS");
                    wifiDisplay.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(wifiDisplay);
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }
        }
    }

    private void configureWebViewForVideoPlayback() {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                WebView webView = getBridge().getWebView();
                WebSettings settings = webView.getSettings();
                settings.setMediaPlaybackRequiresUserGesture(false);
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                settings.setDomStorageEnabled(true);
                webView.addJavascriptInterface(new AndroidCastBridge(), "AndroidCastBridge");

                webView.setDownloadListener(new DownloadListener() {
                    @Override
                    public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                        try {
                            String downloadTargetUrl = url;
                            String fileName = "Video_3A_Stream.mp4";
                            if (url != null && url.contains("filename=")) {
                                int fIdx = url.indexOf("filename=") + 9;
                                String rawF = url.substring(fIdx).split("&")[0];
                                fileName = URLDecoder.decode(rawF, "UTF-8");
                            } else if (contentDisposition != null && !contentDisposition.isEmpty()) {
                                fileName = URLUtil.guessFileName(url, contentDisposition, "video/mp4");
                            }
                            if (!fileName.toLowerCase().endsWith(".mp4")) {
                                fileName = fileName + ".mp4";
                            }
                            // Se for URL do proxy local 127.0.0.1:34567, extrai a URL remota para o DownloadManager do sistema Android
                            if (url != null && url.contains(":34567/proxy") && url.contains("url=")) {
                                int uIdx = url.indexOf("url=") + 4;
                                String rawU = url.substring(uIdx).split("&")[0];
                                String decodedU = URLDecoder.decode(rawU, "UTF-8");
                                downloadTargetUrl = vodRedirectCache.getOrDefault(decodedU, decodedU);
                            }

                            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(downloadTargetUrl));
                            req.setMimeType("video/mp4");
                            req.addRequestHeader("User-Agent", "IPTVSmartersPlayer");
                            req.setTitle(fileName);
                            req.setDescription("Baixando vídeo MP4 — 3A Stream");
                            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

                            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                            if (dm != null) {
                                dm.enqueue(req);
                            }
                        } catch (Exception e) {
                            try {
                                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                                startActivity(i);
                            } catch (Exception ignored) {}
                        }
                    }
                });
            }
        } catch (Exception ignored) {}
    }

    /**
     * Servidor Proxy HTTP Local embarcado no próprio APK Android (0.0.0.0:34567).
     * Atende tanto o próprio aparelho (127.0.0.1:34567) quanto o Chromecast / Smart TV
     * na mesma rede Wi-Fi (http://<IP_WIFI>:34567/proxy?url=...), resolvendo 302 e CORS.
     */
    private synchronized void startLocalStreamProxyServer() {
        if (localProxyServer != null && !localProxyServer.isClosed()) {
            return;
        }
        Thread serverThread = new Thread(() -> {
            try {
                localProxyServer = new ServerSocket(LOCAL_PROXY_PORT, 32, InetAddress.getByName("0.0.0.0"));
                while (!localProxyServer.isClosed()) {
                    final Socket client = localProxyServer.accept();
                    Thread worker = new Thread(() -> handleProxyClient(client));
                    worker.setDaemon(true);
                    worker.start();
                }
            } catch (Exception ignored) {}
        });
        serverThread.setDaemon(true);
        serverThread.start();
    }

    private void closePreviousActiveStream() {
        HttpURLConnection prevConn = activeStreamConn;
        Socket prevSock = activeStreamSocket;
        activeStreamConn = null;
        activeStreamSocket = null;
        if (prevSock != null) {
            try { prevSock.close(); } catch (Exception ignored) {}
        }
        if (prevConn != null) {
            try { prevConn.disconnect(); } catch (Exception ignored) {}
        }
    }

    private void handleProxyClient(Socket client) {
        HttpURLConnection conn = null;
        boolean isApiCall = false;
        try {
            client.setSoTimeout(30000);
            InputStream clientIn = client.getInputStream();
            OutputStream clientOut = client.getOutputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(clientIn, "UTF-8"));

            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) {
                client.close();
                return;
            }

            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "GET";
            String path = parts.length > 1 ? parts[1] : "/";

            String rangeHeader = null;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (line.toLowerCase().startsWith("range:")) {
                    rangeHeader = line.substring(6).trim();
                }
            }

            if ("OPTIONS".equalsIgnoreCase(method)) {
                String optResp = "HTTP/1.1 200 OK\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
                    "Access-Control-Allow-Headers: Range, Content-Type, Accept\r\n" +
                    "Content-Length: 0\r\n\r\n";
                clientOut.write(optResp.getBytes("UTF-8"));
                clientOut.flush();
                client.close();
                return;
            }

            String targetUrl = null;
            int qIdx = path.indexOf("url=");
            if (qIdx != -1) {
                String rawParam = path.substring(qIdx + 4);
                int ampIdx = rawParam.indexOf('&');
                if (ampIdx != -1) {
                    rawParam = rawParam.substring(0, ampIdx);
                }
                targetUrl = URLDecoder.decode(rawParam, "UTF-8");
            }

            if (targetUrl == null || !targetUrl.startsWith("http")) {
                String badResp = "HTTP/1.1 400 Bad Request\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
                clientOut.write(badResp.getBytes("UTF-8"));
                clientOut.flush();
                client.close();
                return;
            }

            String cleanTarget = targetUrl.trim().replace(" ", "%20");
            boolean isVodOrSeries = cleanTarget.contains("/movie/") || cleanTarget.contains("/series/") || cleanTarget.endsWith(".mp4") || cleanTarget.endsWith(".mkv");
            isApiCall = cleanTarget.contains("player_api.php");

            if (!isApiCall) {
                boolean isSameVodTarget = isVodOrSeries && cleanTarget.equals(activeTargetUrl);
                if (!isSameVodTarget) {
                    // Libera imediatamente qualquer stream de outro canal/filme para respeitar max_connections=1
                    closePreviousActiveStream();
                }
                activeTargetUrl = cleanTarget;
                activeStreamSocket = client;
            }

            String currentUrl = vodRedirectCache.getOrDefault(cleanTarget, cleanTarget);

            // Segue até 6 redirecionamentos (301/302/303/307/308) sempre usando GET (evita Content-Length: 0 em HEAD no Cloudflare)
            for (int redirectCount = 0; redirectCount < 6; redirectCount++) {
                URL urlObj = new URL(currentUrl);
                conn = (HttpURLConnection) urlObj.openConnection();
                if (!isApiCall) {
                    activeStreamConn = conn;
                }
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "IPTVSmartersPlayer");
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Connection", "keep-alive");
                if (rangeHeader != null && !rangeHeader.isEmpty()) {
                    conn.setRequestProperty("Range", rangeHeader);
                }

                int code = conn.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    if (location == null || location.isEmpty()) break;
                    location = location.trim().replace(" ", "%20");
                    if (location.startsWith("/")) {
                        currentUrl = urlObj.getProtocol() + "://" + urlObj.getAuthority() + location;
                    } else {
                        currentUrl = location;
                    }
                    if (isVodOrSeries || currentUrl.contains("atlaspainel") || currentUrl.contains("/vauth/")) {
                        vodRedirectCache.put(cleanTarget, currentUrl);
                    }
                } else if (code >= 400 && !currentUrl.equals(cleanTarget)) {
                    // Se o link em cache expirou, limpa o cache e tenta novamente do link original
                    vodRedirectCache.remove(cleanTarget);
                    conn.disconnect();
                    currentUrl = cleanTarget;
                } else {
                    break;
                }
            }

            int status = conn.getResponseCode();
            String statusText = status == 206 ? "Partial Content" : (status == 200 ? "OK" : "Upstream");
            String contentType = conn.getContentType();
            String lowerUrl = (currentUrl + " " + cleanTarget).toLowerCase();

            if (isApiCall) {
                contentType = "application/json; charset=utf-8";
            } else if (contentType == null || contentType.isEmpty() || contentType.contains("octet-stream") || contentType.contains("text/html") || contentType.contains("text/plain")) {
                if (lowerUrl.contains(".mkv")) {
                    contentType = "video/x-matroska";
                } else if (lowerUrl.contains(".ts") && !lowerUrl.contains(".mp4") && !lowerUrl.contains("/movie/") && !lowerUrl.contains("/series/")) {
                    contentType = "video/mp2t";
                } else if (lowerUrl.contains(".m3u8")) {
                    contentType = "application/vnd.apple.mpegurl";
                } else {
                    contentType = "video/mp4";
                }
            }

            String contentLength = conn.getHeaderField("Content-Length");
            String contentRange = conn.getHeaderField("Content-Range");

            StringBuilder respHeaders = new StringBuilder();
            respHeaders.append("HTTP/1.1 ").append(status).append(" ").append(statusText).append("\r\n");
            respHeaders.append("Content-Type: ").append(contentType).append("\r\n");
            respHeaders.append("Access-Control-Allow-Origin: *\r\n");
            respHeaders.append("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n");
            if (!isApiCall) {
                // Sempre envia 'bytes' válido (corrige XUI One que envia '0-735130532')
                respHeaders.append("Accept-Ranges: bytes\r\n");
            }
            if (contentLength != null) {
                respHeaders.append("Content-Length: ").append(contentLength).append("\r\n");
            }
            if (contentRange != null) {
                respHeaders.append("Content-Range: ").append(contentRange).append("\r\n");
            }
            if (path.contains("download=1")) {
                String dlName = "Video_3A_Stream.mp4";
                if (path.contains("filename=")) {
                    int fIdx = path.indexOf("filename=") + 9;
                    String rawF = path.substring(fIdx).split("&")[0];
                    try { dlName = URLDecoder.decode(rawF, "UTF-8"); } catch (Exception ignored) {}
                }
                dlName = dlName.replace("\"", "").replace("\r", "").replace("\n", "");
                if (!dlName.toLowerCase().endsWith(".mp4")) dlName = dlName + ".mp4";
                respHeaders.append("Content-Disposition: attachment; filename=\"").append(dlName).append("\"\r\n");
            }
            respHeaders.append("Connection: close\r\n\r\n");

            clientOut.write(respHeaders.toString().getBytes("UTF-8"));
            clientOut.flush();

            if (!"HEAD".equalsIgnoreCase(method)) {
                InputStream upstreamIn = (status >= 200 && status < 400) ? conn.getInputStream() : conn.getErrorStream();
                if (upstreamIn != null) {
                    byte[] buffer = new byte[65536];
                    int bytesRead;
                    while ((bytesRead = upstreamIn.read(buffer)) != -1) {
                        clientOut.write(buffer, 0, bytesRead);
                    }
                    clientOut.flush();
                    upstreamIn.close();
                }
            }
        } catch (Exception ignored) {
        } finally {
            try {
                if (conn != null) conn.disconnect();
            } catch (Exception ignored) {}
            try {
                client.close();
            } catch (Exception ignored) {}
        }
    }

    /**
     * Mantém os botões do Android (Voltar, Home, Recentes) SEMPRE FIXADOS durante o uso do app,
     * ocultando apenas a barra de status superior (relógio/notificações) para não cortar o topo.
     */
    private void configureSystemBarsAndKeepNavigationFixed() {
        Window window = getWindow();
        if (window == null) return;

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        window.setNavigationBarColor(Color.parseColor("#06080F"));
        window.setStatusBarColor(Color.parseColor("#06080F"));

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(true);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars());
                controller.show(WindowInsets.Type.navigationBars());
            }
        } else {
            View decorView = window.getDecorView();
            decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }
    }

    /**
     * Intercepta o botão Voltar do Android para voltar uma página dentro do app
     * em vez de fechar o aplicativo.
     */
    private void setupAndroidBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                dispatchBackToWebApp();
            }
        });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            dispatchBackToWebApp();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void dispatchBackToWebApp() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> {
                getBridge().getWebView().evaluateJavascript(
                    "(function() { return window.handleAndroidBackButton ? window.handleAndroidBackButton() : 'handled'; })()",
                    value -> {
                        if (value != null && value.contains("exit_app")) {
                            finish();
                        }
                    }
                );
            });
        }
    }
}
