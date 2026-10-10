package com.tresastream.iptv;

import android.app.DownloadManager;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.util.Rational;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.mediarouter.app.MediaRouteChooserDialog;
import androidx.mediarouter.media.MediaControlIntent;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;

import com.getcapacitor.BridgeActivity;
import com.google.android.gms.cast.CastDevice;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManager;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.util.Enumeration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends BridgeActivity {
    private static ServerSocket localProxyServer = null;
    private static final int LOCAL_PROXY_PORT = 34567;
    private static volatile HttpURLConnection activeStreamConn = null;
    private static volatile Socket activeStreamSocket = null;
    private static volatile String activeTargetUrl = null;
    private static final ConcurrentHashMap<String, String> vodRedirectCache = new ConcurrentHashMap<>();

    // Google Cast & MediaRouter & DLNA Discovery State
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private CastContext castContext = null;
    private MediaRouter mediaRouter = null;
    private MediaRouteSelector mediaRouteSelector = null;
    private WifiManager.MulticastLock multicastLock = null;
    private NsdManager nsdManager = null;
    private NsdManager.DiscoveryListener nsdDiscoveryListener = null;

    private static class PendingCastMedia {
        String streamUrl;
        String title;
        String subtitle;
        String posterUrl;
        String mimeType;
        long positionMs;
    }

    private static class DiscoveredTvDevice {
        String id;
        String name;
        String model;
        String type; // "chromecast" | "dlna"
        String ip;
        int port;
        String controlUrl; // Para DLNA AVTransport
        MediaRouter.RouteInfo routeInfo; // Para Chromecast MediaRouter
    }

    private volatile PendingCastMedia pendingCastMedia = null;
    private volatile DiscoveredTvDevice activeDlnaDevice = null;
    private final ConcurrentHashMap<String, DiscoveredTvDevice> discoveredTvs = new ConcurrentHashMap<>();

    private final MediaRouter.Callback mediaRouterCallback = new MediaRouter.Callback() {
        @Override
        public void onRouteAdded(@NonNull MediaRouter router, @NonNull MediaRouter.RouteInfo route) {
            registerMediaRouteDevice(route);
        }

        @Override
        public void onRouteChanged(@NonNull MediaRouter router, @NonNull MediaRouter.RouteInfo route) {
            registerMediaRouteDevice(route);
        }

        @Override
        public void onRouteRemoved(@NonNull MediaRouter router, @NonNull MediaRouter.RouteInfo route) {
            if (route != null && route.getId() != null) {
                discoveredTvs.remove("route:" + route.getId());
            }
        }
    };

    private final SessionManagerListener<CastSession> castSessionListener = new SessionManagerListener<CastSession>() {
        @Override
        public void onSessionStarting(@NonNull CastSession session) {}

        @Override
        public void onSessionStarted(@NonNull CastSession session, @NonNull String sessionId) {
            String devName = session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : "Chromecast";
            notifyWebCastState(true, devName);
            if (pendingCastMedia != null) {
                loadMediaIntoCastSession(session, pendingCastMedia);
            }
        }

        @Override
        public void onSessionStartFailed(@NonNull CastSession session, int error) {
            notifyWebCastState(false, "");
        }

        @Override
        public void onSessionEnding(@NonNull CastSession session) {}

        @Override
        public void onSessionEnded(@NonNull CastSession session, int error) {
            notifyWebCastState(false, "");
        }

        @Override
        public void onSessionResuming(@NonNull CastSession session, @NonNull String sessionId) {}

        @Override
        public void onSessionResumed(@NonNull CastSession session, boolean wasSuspended) {
            String devName = session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : "Chromecast";
            notifyWebCastState(true, devName);
            if (pendingCastMedia != null) {
                loadMediaIntoCastSession(session, pendingCastMedia);
            }
        }

        @Override
        public void onSessionResumeFailed(@NonNull CastSession session, int error) {}

        @Override
        public void onSessionSuspended(@NonNull CastSession session, int reason) {}
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        configureSystemBarsAndKeepNavigationFixed();
        configureWebViewForVideoPlayback();
        startLocalStreamProxyServer();
        setupAndroidBackNavigation();
        initNativeCastAndTvDiscovery();
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
        startWifiTvDiscoveryScan();
    }

    private static volatile boolean isVideoPlaying = false;

    public void triggerAndroidNativePip() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PictureInPictureParams.Builder pipBuilder = new PictureInPictureParams.Builder();
                pipBuilder.setAspectRatio(new Rational(16, 9));
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    pipBuilder.setAutoEnterEnabled(true);
                    pipBuilder.setSeamlessResizeEnabled(true);
                }
                enterPictureInPictureMode(pipBuilder.build());
            } catch (Exception e) {
                try {
                    enterPictureInPictureMode();
                } catch (Exception ignored) {}
            }
        }
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (isVideoPlaying && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            triggerAndroidNativePip();
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                String js = "if (typeof handleNativePipModeChange === 'function') handleNativePipModeChange(" + isInPictureInPictureMode + ");";
                getBridge().getWebView().evaluateJavascript(js, null);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) {
                multicastLock.release();
            }
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    private void initNativeCastAndTvDiscovery() {
        mainHandler.post(() -> {
            try {
                WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null && multicastLock == null) {
                    multicastLock = wifi.createMulticastLock("3AStreamCastMulticastLock");
                    multicastLock.setReferenceCounted(false);
                    multicastLock.acquire();
                }
            } catch (Exception ignored) {}

            try {
                mediaRouter = MediaRouter.getInstance(getApplicationContext());
                mediaRouteSelector = new MediaRouteSelector.Builder()
                    .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                    .addControlCategory(MediaControlIntent.CATEGORY_REMOTE_PLAYBACK)
                    .addControlCategory(MediaControlIntent.CATEGORY_LIVE_VIDEO)
                    .build();

                mediaRouter.addCallback(
                    mediaRouteSelector,
                    mediaRouterCallback,
                    MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN | MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY
                );

                for (MediaRouter.RouteInfo route : mediaRouter.getRoutes()) {
                    registerMediaRouteDevice(route);
                }
            } catch (Exception ignored) {}

            try {
                castContext = CastContext.getSharedInstance(this);
                SessionManager sm = castContext.getSessionManager();
                sm.addSessionManagerListener(castSessionListener, CastSession.class);
            } catch (Exception ignored) {}

            startWifiTvDiscoveryScan();
        });
    }

    private void registerMediaRouteDevice(MediaRouter.RouteInfo route) {
        try {
            if (route == null || route.isDefault() || !route.isEnabled()) return;
            String name = route.getName() != null ? route.getName().trim() : "";
            if (name.isEmpty()) return;
            String lower = name.toLowerCase();
            if (lower.contains("phone") || lower.contains("telefone") || lower.contains("este aparelho") || lower.contains("this device") || lower.contains("speaker")) {
                return;
            }

            CastDevice castDev = CastDevice.getFromBundle(route.getExtras());
            boolean matchesCast = route.matchesSelector(mediaRouteSelector) || castDev != null;
            if (!matchesCast && !lower.contains("tv") && !lower.contains("cast") && !lower.contains("stick") && !lower.contains("box") && !lower.contains("roku") && !lower.contains("lg") && !lower.contains("samsung")) {
                return;
            }

            DiscoveredTvDevice dev = new DiscoveredTvDevice();
            dev.id = "route:" + route.getId();
            dev.name = castDev != null && castDev.getFriendlyName() != null ? castDev.getFriendlyName() : name;
            dev.model = castDev != null && castDev.getModelName() != null ? castDev.getModelName() : (route.getDescription() != null ? route.getDescription() : "Chromecast / Google TV");
            dev.type = "chromecast";
            dev.ip = (castDev != null && castDev.getInetAddress() != null) ? castDev.getInetAddress().getHostAddress() : "";
            dev.routeInfo = route;
            discoveredTvs.put(dev.id, dev);
        } catch (Exception ignored) {}
    }

    private void startWifiTvDiscoveryScan() {
        // 1. Atualiza rotas do MediaRouter na Main Thread
        mainHandler.post(() -> {
            try {
                if (mediaRouter != null && mediaRouteSelector != null) {
                    mediaRouter.removeCallback(mediaRouterCallback);
                    mediaRouter.addCallback(
                        mediaRouteSelector,
                        mediaRouterCallback,
                        MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN | MediaRouter.CALLBACK_FLAG_REQUEST_DISCOVERY
                    );
                    for (MediaRouter.RouteInfo route : mediaRouter.getRoutes()) {
                        registerMediaRouteDevice(route);
                    }
                }
            } catch (Exception ignored) {}
        });

        // 2. Inicia scan mDNS (_googlecast._tcp.) via Android NsdManager
        try {
            if (nsdManager == null) {
                nsdManager = (NsdManager) getApplicationContext().getSystemService(Context.NSD_SERVICE);
            }
            if (nsdManager != null && nsdDiscoveryListener == null) {
                nsdDiscoveryListener = new NsdManager.DiscoveryListener() {
                    @Override
                    public void onDiscoveryStarted(String regType) {}

                    @Override
                    public void onServiceFound(NsdServiceInfo service) {
                        try {
                            nsdManager.resolveService(service, new NsdManager.ResolveListener() {
                                @Override
                                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {}

                                @Override
                                public void onServiceResolved(NsdServiceInfo resolvedInfo) {
                                    try {
                                        InetAddress host = resolvedInfo.getHost();
                                        String ip = host != null ? host.getHostAddress() : "";
                                        String fn = resolvedInfo.getServiceName();
                                        String md = "Chromecast / Google TV";
                                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                                            Map<String, byte[]> attrs = resolvedInfo.getAttributes();
                                            if (attrs != null) {
                                                if (attrs.get("fn") != null) {
                                                    fn = new String(attrs.get("fn"), "UTF-8");
                                                }
                                                if (attrs.get("md") != null) {
                                                    md = new String(attrs.get("md"), "UTF-8");
                                                }
                                            }
                                        }
                                        // Verifica se já existe rota MediaRouter com o mesmo IP ou nome
                                        for (DiscoveredTvDevice existing : discoveredTvs.values()) {
                                            if ("chromecast".equals(existing.type) && existing.routeInfo != null) {
                                                if ((ip != null && !ip.isEmpty() && ip.equals(existing.ip)) || existing.name.equalsIgnoreCase(fn)) {
                                                    return;
                                                }
                                            }
                                        }
                                        DiscoveredTvDevice dev = new DiscoveredTvDevice();
                                        dev.id = "mdns:" + (ip != null && !ip.isEmpty() ? ip : fn);
                                        dev.name = fn;
                                        dev.model = md;
                                        dev.type = "chromecast";
                                        dev.ip = ip != null ? ip : "";
                                        dev.port = resolvedInfo.getPort();
                                        discoveredTvs.put(dev.id, dev);
                                    } catch (Exception ignored) {}
                                }
                            });
                        } catch (Exception ignored) {}
                    }

                    @Override
                    public void onServiceLost(NsdServiceInfo service) {}

                    @Override
                    public void onDiscoveryStopped(String serviceType) {
                        nsdDiscoveryListener = null;
                    }

                    @Override
                    public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                        nsdDiscoveryListener = null;
                    }

                    @Override
                    public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
                };
                nsdManager.discoverServices("_googlecast._tcp.", NsdManager.PROTOCOL_DNS_SD, nsdDiscoveryListener);
            }
        } catch (Exception ignored) {}

        // 3. Inicia scan SSDP / UPnP DLNA para Smart TVs (Samsung, LG, Roku, Philips, TCL, Sony, Hisense) na mesma rede Wi-Fi
        Thread ssdpThread = new Thread(this::scanDlnaSmartTvsOnWifi);
        ssdpThread.setDaemon(true);
        ssdpThread.start();
    }

    private void scanDlnaSmartTvsOnWifi() {
        DatagramSocket socket = null;
        try {
            socket = new DatagramSocket();
            socket.setBroadcast(true);
            socket.setSoTimeout(2200);
            InetAddress multicastAddr = InetAddress.getByName("239.255.255.250");

            String[] searchTargets = new String[] {
                "urn:schemas-upnp-org:service:AVTransport:1",
                "urn:schemas-upnp-org:device:MediaRenderer:1",
                "urn:dial-multiscreen-org:service:dial:1"
            };

            for (String st : searchTargets) {
                String msg = "M-SEARCH * HTTP/1.1\r\n" +
                    "HOST: 239.255.255.250:1900\r\n" +
                    "MAN: \"ssdp:discover\"\r\n" +
                    "MX: 2\r\n" +
                    "ST: " + st + "\r\n\r\n";
                byte[] sendData = msg.getBytes("UTF-8");
                DatagramPacket sendPacket = new DatagramPacket(sendData, sendData.length, multicastAddr, 1900);
                socket.send(sendPacket);
            }

            long startTime = System.currentTimeMillis();
            byte[] recvBuf = new byte[4096];
            while (System.currentTimeMillis() - startTime < 2600) {
                DatagramPacket receivePacket = new DatagramPacket(recvBuf, recvBuf.length);
                socket.receive(receivePacket);
                String resp = new String(receivePacket.getData(), 0, receivePacket.getLength(), "UTF-8");
                String location = extractHttpHeader(resp, "location");
                String ip = receivePacket.getAddress() != null ? receivePacket.getAddress().getHostAddress() : "";
                if (location != null && location.startsWith("http")) {
                    fetchDlnaDeviceDetails(location, ip);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (socket != null) {
                try { socket.close(); } catch (Exception ignored) {}
            }
        }
    }

    private String extractHttpHeader(String rawHeaders, String headerName) {
        if (rawHeaders == null) return null;
        String[] lines = rawHeaders.split("\r?\n");
        String prefix = headerName.toLowerCase() + ":";
        for (String line : lines) {
            if (line.toLowerCase().startsWith(prefix)) {
                return line.substring(prefix.length()).trim();
            }
        }
        return null;
    }

    private void fetchDlnaDeviceDetails(String locationUrl, String ip) {
        try {
            URL url = new URL(locationUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(2500);
            conn.setReadTimeout(2500);
            conn.setRequestMethod("GET");
            if (conn.getResponseCode() != 200) {
                conn.disconnect();
                return;
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
            reader.close();
            conn.disconnect();

            String xml = sb.toString();
            String friendlyName = extractXmlTag(xml, "friendlyName");
            String modelName = extractXmlTag(xml, "modelName");
            if (friendlyName == null || friendlyName.isEmpty()) return;

            // Ignora roteadores / gateways que não são TVs nem MediaRenderers
            String lowerXml = xml.toLowerCase();
            if (!lowerXml.contains("avtransport") && !lowerXml.contains("mediarenderer") && !lowerXml.contains("renderingcontrol") && !lowerXml.contains("dial")) {
                return;
            }

            String avControlUrl = extractAvTransportControlUrl(xml, url);
            if (avControlUrl == null || avControlUrl.isEmpty()) return;

            DiscoveredTvDevice dev = new DiscoveredTvDevice();
            dev.id = "dlna:" + ip + ":" + friendlyName;
            dev.name = friendlyName;
            dev.model = (modelName != null && !modelName.isEmpty()) ? modelName : "Smart TV DLNA / UPnP";
            dev.type = "dlna";
            dev.ip = ip;
            dev.controlUrl = avControlUrl;
            discoveredTvs.put(dev.id, dev);
        } catch (Exception ignored) {}
    }

    private String extractXmlTag(String xml, String tag) {
        if (xml == null) return null;
        String open = "<" + tag + ">";
        String close = "</" + tag + ">";
        int idx1 = xml.indexOf(open);
        int idx2 = xml.indexOf(close);
        if (idx1 != -1 && idx2 > idx1) {
            return xml.substring(idx1 + open.length(), idx2).trim();
        }
        return null;
    }

    private String extractAvTransportControlUrl(String xml, URL baseUrl) {
        try {
            int svcIdx = xml.indexOf("AVTransport");
            if (svcIdx == -1) return null;
            int ctrlStart = xml.indexOf("<controlURL>", svcIdx);
            int ctrlEnd = xml.indexOf("</controlURL>", svcIdx);
            if (ctrlStart == -1 || ctrlEnd == -1) return null;
            String rawCtrl = xml.substring(ctrlStart + 12, ctrlEnd).trim();
            if (rawCtrl.startsWith("http://") || rawCtrl.startsWith("https://")) {
                return rawCtrl;
            }
            String baseOrigin = baseUrl.getProtocol() + "://" + baseUrl.getAuthority();
            if (rawCtrl.startsWith("/")) {
                return baseOrigin + rawCtrl;
            }
            return baseOrigin + "/" + rawCtrl;
        } catch (Exception e) {
            return null;
        }
    }

    private boolean sendDlnaAvTransportPlay(DiscoveredTvDevice tv, String streamUrl, String title, String mimeType) {
        if (tv == null || tv.controlUrl == null || tv.controlUrl.isEmpty()) return false;
        try {
            String escapedUrl = streamUrl
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;");
            String escapedTitle = (title != null ? title : "3A Stream")
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;");

            String setUriBody = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
                "<s:Body>" +
                "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">" +
                "<InstanceID>0</InstanceID>" +
                "<CurrentURI>" + escapedUrl + "</CurrentURI>" +
                "<CurrentURIMetaData>&lt;DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"&gt;&lt;item id=\"0\" parentID=\"-1\" restricted=\"1\"&gt;&lt;dc:title&gt;" + escapedTitle + "&lt;/dc:title&gt;&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;&lt;res protocolInfo=\"http-get:*:" + (mimeType != null ? mimeType : "video/mp4") + ":*\"&gt;" + escapedUrl + "&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData>" +
                "</u:SetAVTransportURI>" +
                "</s:Body>" +
                "</s:Envelope>";

            int code1 = sendSoapPost(tv.controlUrl, "\"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\"", setUriBody);
            if (code1 >= 200 && code1 < 300) {
                String playBody = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">" +
                    "<s:Body>" +
                    "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">" +
                    "<InstanceID>0</InstanceID>" +
                    "<Speed>1</Speed>" +
                    "</u:Play>" +
                    "</s:Body>" +
                    "</s:Envelope>";
                sendSoapPost(tv.controlUrl, "\"urn:schemas-upnp-org:service:AVTransport:1#Play\"", playBody);
                activeDlnaDevice = tv;
                notifyWebCastState(true, tv.name);
                return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private int sendSoapPost(String controlUrl, String soapAction, String xmlPayload) throws Exception {
        URL url = new URL(controlUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(5000);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"");
        conn.setRequestProperty("SOAPAction", soapAction);
        byte[] data = xmlPayload.getBytes("UTF-8");
        conn.setRequestProperty("Content-Length", String.valueOf(data.length));
        OutputStream os = conn.getOutputStream();
        os.write(data);
        os.flush();
        os.close();
        int responseCode = conn.getResponseCode();
        conn.disconnect();
        return responseCode;
    }

    private void loadMediaIntoCastSession(CastSession session, PendingCastMedia media) {
        if (session == null || media == null) return;
        mainHandler.post(() -> {
            try {
                RemoteMediaClient remoteMediaClient = session.getRemoteMediaClient();
                if (remoteMediaClient == null) return;

                MediaMetadata metadata = new MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE);
                metadata.putString(MediaMetadata.KEY_TITLE, media.title != null ? media.title : "3A Stream");
                if (media.subtitle != null && !media.subtitle.isEmpty()) {
                    metadata.putString(MediaMetadata.KEY_SUBTITLE, media.subtitle);
                }
                if (media.posterUrl != null && media.posterUrl.startsWith("http")) {
                    metadata.addImage(new WebImage(Uri.parse(media.posterUrl)));
                }

                String cType = (media.mimeType != null && !media.mimeType.isEmpty()) ? media.mimeType : "video/mp4";
                int streamType = cType.toLowerCase().contains("mpegurl")
                    ? MediaInfo.STREAM_TYPE_LIVE
                    : MediaInfo.STREAM_TYPE_BUFFERED;

                MediaInfo mediaInfo = new MediaInfo.Builder(media.streamUrl)
                    .setStreamType(streamType)
                    .setContentType(cType)
                    .setMetadata(metadata)
                    .build();

                MediaLoadRequestData requestData = new MediaLoadRequestData.Builder()
                    .setMediaInfo(mediaInfo)
                    .setAutoplay(Boolean.TRUE)
                    .setCurrentTime(streamType == MediaInfo.STREAM_TYPE_LIVE ? 0L : Math.max(0L, media.positionMs))
                    .build();

                remoteMediaClient.load(requestData);
                String devName = session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : "Chromecast";
                notifyWebCastState(true, devName);
            } catch (Exception ignored) {}
        });
    }

    private void notifyWebCastState(boolean connected, String deviceName) {
        if (getBridge() != null && getBridge().getWebView() != null) {
            final String safeName = (deviceName != null ? deviceName : "TV").replace("'", "\\'");
            getBridge().getWebView().post(() -> {
                getBridge().getWebView().evaluateJavascript(
                    "if (window.onAndroidNativeCastStateChanged) { window.onAndroidNativeCastStateChanged(" + connected + ", '" + safeName + "'); }",
                    null
                );
            });
        }
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
        public void startTvDiscovery() {
            startWifiTvDiscoveryScan();
        }

        @JavascriptInterface
        public String getDiscoveredTvsJson() {
            try {
                JSONArray arr = new JSONArray();
                for (DiscoveredTvDevice dev : discoveredTvs.values()) {
                    JSONObject obj = new JSONObject();
                    obj.put("id", dev.id);
                    obj.put("name", dev.name);
                    obj.put("model", dev.model != null ? dev.model : "");
                    obj.put("type", dev.type);
                    obj.put("ip", dev.ip != null ? dev.ip : "");
                    arr.put(obj);
                }
                return arr.toString();
            } catch (Exception e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public boolean connectAndCastToTv(String deviceId, String streamUrl, String title, String subtitle, String posterUrl, String mimeType, int positionSeconds) {
            PendingCastMedia pending = new PendingCastMedia();
            pending.streamUrl = streamUrl;
            pending.title = title;
            pending.subtitle = subtitle;
            pending.posterUrl = posterUrl;
            pending.mimeType = mimeType;
            pending.positionMs = Math.max(0L, positionSeconds * 1000L);
            pendingCastMedia = pending;

            DiscoveredTvDevice dev = discoveredTvs.get(deviceId);
            if (dev != null && "dlna".equals(dev.type)) {
                new Thread(() -> sendDlnaAvTransportPlay(dev, streamUrl, title, mimeType)).start();
                return true;
            }

            mainHandler.post(() -> {
                try {
                    if (castContext != null) {
                        CastSession currentSession = castContext.getSessionManager().getCurrentCastSession();
                        if (currentSession != null && currentSession.isConnected()) {
                            if (dev == null || dev.routeInfo == null || dev.routeInfo.isSelected()) {
                                loadMediaIntoCastSession(currentSession, pending);
                                return;
                            }
                        }
                    }

                    if (dev != null && dev.routeInfo != null && mediaRouter != null) {
                        mediaRouter.selectRoute(dev.routeInfo);
                        return;
                    }

                    // Se foi descoberto via mDNS, procura rota correspondente no MediaRouter ou abre o seletor nativo
                    if (dev != null && mediaRouter != null) {
                        for (MediaRouter.RouteInfo route : mediaRouter.getRoutes()) {
                            if (route.getName() != null && route.getName().equalsIgnoreCase(dev.name)) {
                                mediaRouter.selectRoute(route);
                                return;
                            }
                        }
                    }

                    openNativeCastChooserInternal();
                } catch (Exception ignored) {}
            });
            return true;
        }

        @JavascriptInterface
        public void openNativeCastChooserDialog(String streamUrl, String title, String subtitle, String posterUrl, String mimeType, int positionSeconds) {
            PendingCastMedia pending = new PendingCastMedia();
            pending.streamUrl = streamUrl;
            pending.title = title;
            pending.subtitle = subtitle;
            pending.posterUrl = posterUrl;
            pending.mimeType = mimeType;
            pending.positionMs = Math.max(0L, positionSeconds * 1000L);
            pendingCastMedia = pending;

            mainHandler.post(MainActivity.this::openNativeCastChooserInternal);
        }

        @JavascriptInterface
        public void controlNativeCast(String action) {
            mainHandler.post(() -> {
                try {
                    if ("disconnect".equals(action)) {
                        if (castContext != null && castContext.getSessionManager().getCurrentCastSession() != null) {
                            castContext.getSessionManager().endCurrentSession(true);
                        }
                        if (mediaRouter != null) {
                            mediaRouter.unselect(MediaRouter.UNSELECT_REASON_STOPPED);
                        }
                        if (activeDlnaDevice != null) {
                            final DiscoveredTvDevice dlna = activeDlnaDevice;
                            activeDlnaDevice = null;
                            new Thread(() -> {
                                try {
                                    String stopXml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\"><InstanceID>0</InstanceID></u:Stop></s:Body></s:Envelope>";
                                    sendSoapPost(dlna.controlUrl, "\"urn:schemas-upnp-org:service:AVTransport:1#Stop\"", stopXml);
                                } catch (Exception ignored) {}
                            }).start();
                        }
                        notifyWebCastState(false, "");
                        return;
                    }

                    if (castContext != null) {
                        CastSession session = castContext.getSessionManager().getCurrentCastSession();
                        if (session != null && session.getRemoteMediaClient() != null) {
                            RemoteMediaClient client = session.getRemoteMediaClient();
                            if ("togglePlay".equals(action)) {
                                client.togglePlayback();
                            } else if ("rewind10".equals(action)) {
                                long pos = Math.max(0L, client.getApproximateStreamPosition() - 10000L);
                                client.seek(pos);
                            } else if ("forward10".equals(action)) {
                                long pos = client.getApproximateStreamPosition() + 10000L;
                                client.seek(pos);
                            }
                        }
                    }
                } catch (Exception ignored) {}
            });
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
                Intent chooser = Intent.createChooser(intent, "Transmitir com App Externo");
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

        @JavascriptInterface
        public void setVideoPlayingState(boolean playing) {
            isVideoPlaying = playing;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                mainHandler.post(() -> {
                    try {
                        PictureInPictureParams.Builder pipBuilder = new PictureInPictureParams.Builder();
                        pipBuilder.setAspectRatio(new Rational(16, 9));
                        pipBuilder.setAutoEnterEnabled(playing);
                        pipBuilder.setSeamlessResizeEnabled(true);
                        setPictureInPictureParams(pipBuilder.build());
                    } catch (Exception ignored) {}
                });
            }
        }

        @JavascriptInterface
        public boolean enterNativePip() {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                mainHandler.post(() -> {
                    triggerAndroidNativePip();
                });
                return true;
            }
            return false;
        }
    }

    private void openNativeCastChooserInternal() {
        try {
            if (castContext != null) {
                CastSession session = castContext.getSessionManager().getCurrentCastSession();
                if (session != null && session.isConnected() && pendingCastMedia != null) {
                    loadMediaIntoCastSession(session, pendingCastMedia);
                    return;
                }
            }
            MediaRouteChooserDialog dialog = new MediaRouteChooserDialog(MainActivity.this);
            if (mediaRouteSelector != null) {
                dialog.setRouteSelector(mediaRouteSelector);
            }
            dialog.show();
        } catch (Exception ignored) {}
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
                boolean isSameTarget = cleanTarget.equals(activeTargetUrl);
                if (!isSameTarget) {
                    closePreviousActiveStream();
                }
                activeTargetUrl = cleanTarget;
                activeStreamSocket = client;
            }

            String currentUrl = vodRedirectCache.getOrDefault(cleanTarget, cleanTarget);

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
