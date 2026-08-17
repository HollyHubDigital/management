package com.cpdevice.agent;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.JavaI420Buffer;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpSender;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class WebRtcLiveSender implements SimpleWebSocketClient.Listener {
    private static boolean initialized;
    private final Context context;
    private final boolean cameraMode;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, PeerConnection> peers = new ConcurrentHashMap<>();
    private final List<PeerConnection.IceServer> iceServers = Collections.synchronizedList(new ArrayList<>());
    private SimpleWebSocketClient signaling;
    private EglBase eglBase;
    private PeerConnectionFactory factory;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private volatile boolean closed;
    private volatile boolean videoStarted;
    private volatile long lastFrameAt;

    private WebRtcLiveSender(Context context, boolean cameraMode) {
        this.context = context.getApplicationContext();
        this.cameraMode = cameraMode;
    }

    public static WebRtcLiveSender start(Context context, SharedPreferences prefs, boolean cameraMode) {
        WebRtcLiveSender sender = new WebRtcLiveSender(context, cameraMode);
        sender.start(prefs);
        return sender;
    }

    private void start(SharedPreferences prefs) {
        executor.execute(() -> {
            try {
                createFactory();
                createLocalTracks();
                String serverUrl = liveServerUrl(prefs);
                String deviceId = prefs.getString("deviceId", "");
                String token = prefs.getString("deviceToken", "");
                if (deviceId.length() == 0 || token.length() == 0) return;
                String wsUrl = serverUrl.replace("http://", "ws://").replace("https://", "wss://") + "/ws/webrtc-device/" + deviceId + "?token=" + token;
                signaling = new SimpleWebSocketClient();
                signaling.setListener(this);
                signaling.connect(wsUrl);
            } catch (Exception ignored) { }
        });
    }

    private void createFactory() {
        if (!initialized) {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
            initialized = true;
        }
        eglBase = EglBase.create();
        JavaAudioDeviceModule audioModule = JavaAudioDeviceModule.builder(context).createAudioDeviceModule();
        factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(eglBase.getEglBaseContext()))
                .setAudioDeviceModule(audioModule)
                .createPeerConnectionFactory();
    }

    private void createLocalTracks() {
        videoSource = factory.createVideoSource(!cameraMode);
        videoTrack = factory.createVideoTrack(cameraMode ? "shield-camera-video" : "shield-screen-video", videoSource);
        videoTrack.setEnabled(true);
        videoSource.getCapturerObserver().onCapturerStarted(true);
        if (cameraMode) {
            audioSource = factory.createAudioSource(new MediaConstraints());
            audioTrack = factory.createAudioTrack("shield-camera-audio", audioSource);
            audioTrack.setEnabled(true);
        }
    }

    public void pushJpegFrame(byte[] jpeg) {
        if (closed || jpeg == null || jpeg.length == 0) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastFrameAt < 66) return;
        lastFrameAt = now;
        executor.execute(() -> {
            try {
                Bitmap bitmap = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
                if (bitmap == null) return;
                pushBitmapFrameInternal(bitmap);
                bitmap.recycle();
            } catch (Exception ignored) { }
        });
    }

    public void pushBitmapFrame(Bitmap bitmap) {
        if (closed || bitmap == null) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastFrameAt < 66) return;
        lastFrameAt = now;
        Bitmap copy = bitmap.copy(Bitmap.Config.ARGB_8888, false);
        executor.execute(() -> {
            try { pushBitmapFrameInternal(copy); } catch (Exception ignored) { }
            try { copy.recycle(); } catch (Exception ignored) { }
        });
    }

    private void pushBitmapFrameInternal(Bitmap bitmap) {
        if (closed || videoSource == null || bitmap == null) return;
        Bitmap source = bitmap.getConfig() == Bitmap.Config.ARGB_8888 ? bitmap : bitmap.copy(Bitmap.Config.ARGB_8888, false);
        JavaI420Buffer buffer = bitmapToI420(source);
        VideoFrame frame = new VideoFrame(buffer, 0, System.nanoTime());
        videoSource.getCapturerObserver().onFrameCaptured(frame);
        frame.release();
        if (source != bitmap) source.recycle();
        videoStarted = true;
    }

    private JavaI420Buffer bitmapToI420(Bitmap bitmap) {
        int width = bitmap.getWidth() & ~1;
        int height = bitmap.getHeight() & ~1;
        int[] pixels = new int[width * height];
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height);
        JavaI420Buffer buffer = JavaI420Buffer.allocate(width, height);
        ByteBuffer yPlane = buffer.getDataY();
        ByteBuffer uPlane = buffer.getDataU();
        ByteBuffer vPlane = buffer.getDataV();
        int strideY = buffer.getStrideY();
        int strideU = buffer.getStrideU();
        int strideV = buffer.getStrideV();
        for (int row = 0; row < height; row++) {
            for (int col = 0; col < width; col++) {
                int pixel = pixels[row * width + col];
                int red = (pixel >> 16) & 255;
                int green = (pixel >> 8) & 255;
                int blue = pixel & 255;
                int y = clamp(((66 * red + 129 * green + 25 * blue + 128) >> 8) + 16);
                yPlane.put(row * strideY + col, (byte) y);
                if ((row & 1) == 0 && (col & 1) == 0) {
                    int u = clamp(((-38 * red - 74 * green + 112 * blue + 128) >> 8) + 128);
                    int v = clamp(((112 * red - 94 * green - 18 * blue + 128) >> 8) + 128);
                    int chromaIndex = (row / 2) * strideU + (col / 2);
                    uPlane.put(chromaIndex, (byte) u);
                    vPlane.put((row / 2) * strideV + (col / 2), (byte) v);
                }
            }
        }
        return buffer;
    }

    private int clamp(int value) {
        return Math.max(0, Math.min(255, value));
    }

    @Override public void onText(String text) {
        executor.execute(() -> handleSignal(text));
    }

    @Override public void onClosed() { }

    private void handleSignal(String text) {
        try {
            JSONObject message = new JSONObject(text);
            String type = message.optString("type", "");
            if ("ready".equals(type)) {
                parseIceServers(message.optJSONArray("iceServers"));
                return;
            }
            String viewerId = message.optString("viewerId", "default");
            if ("viewer.left".equals(type)) { closePeer(viewerId); return; }
            if ("offer".equals(type)) { handleOffer(viewerId, message); return; }
            if ("candidate".equals(type)) { handleCandidate(viewerId, message); }
        } catch (Exception ignored) { }
    }

    private void handleOffer(String viewerId, JSONObject message) throws Exception {
        parseIceServers(message.optJSONArray("iceServers"));
        PeerConnection peer = createPeer(viewerId);
        JSONObject sdp = message.optJSONObject("sdp");
        if (sdp == null) return;
        SessionDescription remote = new SessionDescription(SessionDescription.Type.OFFER, sdp.optString("sdp", ""));
        peer.setRemoteDescription(new SimpleSdpObserver() {
            @Override public void onSetSuccess() {
                MediaConstraints constraints = new MediaConstraints();
                peer.createAnswer(new SimpleSdpObserver() {
                    @Override public void onCreateSuccess(SessionDescription answer) {
                        peer.setLocalDescription(new SimpleSdpObserver() {
                            @Override public void onSetSuccess() { sendAnswer(viewerId, answer); }
                        }, answer);
                    }
                }, constraints);
            }
        }, remote);
    }

    private PeerConnection createPeer(String viewerId) {
        closePeer(viewerId);
        List<PeerConnection.IceServer> servers = new ArrayList<>(iceServers);
        if (servers.isEmpty()) servers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(servers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        config.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        PeerConnection peer = factory.createPeerConnection(config, new PeerConnection.Observer() {
            @Override public void onIceCandidate(IceCandidate candidate) { sendCandidate(viewerId, candidate); }
            @Override public void onSignalingChange(PeerConnection.SignalingState state) { }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) { }
            @Override public void onIceConnectionReceivingChange(boolean receiving) { }
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) { }
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) { }
            @Override public void onAddStream(org.webrtc.MediaStream stream) { }
            @Override public void onRemoveStream(org.webrtc.MediaStream stream) { }
            @Override public void onDataChannel(org.webrtc.DataChannel channel) { }
            @Override public void onRenegotiationNeeded() { }
            @Override public void onAddTrack(org.webrtc.RtpReceiver receiver, org.webrtc.MediaStream[] streams) { }
        });
        if (peer == null) throw new IllegalStateException("PeerConnection unavailable");
        List<String> streamIds = Collections.singletonList("shield-live");
        RtpSender videoSender = peer.addTrack(videoTrack, streamIds);
        if (videoSender != null && videoSender.getParameters() != null) { }
        if (cameraMode && audioTrack != null) peer.addTrack(audioTrack, streamIds);
        peers.put(viewerId, peer);
        return peer;
    }

    private void handleCandidate(String viewerId, JSONObject message) throws Exception {
        PeerConnection peer = peers.get(viewerId);
        if (peer == null) return;
        JSONObject candidate = message.optJSONObject("candidate");
        if (candidate == null) return;
        peer.addIceCandidate(new IceCandidate(candidate.optString("sdpMid"), candidate.optInt("sdpMLineIndex"), candidate.optString("candidate")));
    }

    private void parseIceServers(JSONArray array) {
        if (array == null) return;
        iceServers.clear();
        for (int index = 0; index < array.length(); index++) {
            JSONObject server = array.optJSONObject(index);
            if (server == null) continue;
            String username = server.optString("username", "");
            String credential = server.optString("credential", "");
            Object urls = server.opt("urls");
            if (urls instanceof JSONArray) {
                JSONArray list = (JSONArray) urls;
                for (int urlIndex = 0; urlIndex < list.length(); urlIndex++) addIceServer(list.optString(urlIndex), username, credential);
            } else {
                addIceServer(server.optString("urls", ""), username, credential);
            }
        }
    }

    private void addIceServer(String url, String username, String credential) {
        if (url == null || url.length() == 0) return;
        PeerConnection.IceServer.Builder builder = PeerConnection.IceServer.builder(url);
        if (username.length() > 0) builder.setUsername(username);
        if (credential.length() > 0) builder.setPassword(credential);
        iceServers.add(builder.createIceServer());
    }

    private void sendAnswer(String viewerId, SessionDescription answer) {
        try {
            JSONObject sdp = new JSONObject();
            sdp.put("type", "answer");
            sdp.put("sdp", answer.description);
            JSONObject payload = new JSONObject();
            payload.put("type", "answer");
            payload.put("viewerId", viewerId);
            payload.put("sdp", sdp);
            send(payload);
        } catch (Exception ignored) { }
    }

    private void sendCandidate(String viewerId, IceCandidate candidate) {
        try {
            JSONObject inner = new JSONObject();
            inner.put("candidate", candidate.sdp);
            inner.put("sdpMid", candidate.sdpMid);
            inner.put("sdpMLineIndex", candidate.sdpMLineIndex);
            JSONObject payload = new JSONObject();
            payload.put("type", "candidate");
            payload.put("viewerId", viewerId);
            payload.put("candidate", inner);
            send(payload);
        } catch (Exception ignored) { }
    }

    private void send(JSONObject payload) throws Exception {
        if (signaling != null) signaling.sendText(payload.toString());
    }

    private void closePeer(String viewerId) {
        PeerConnection peer = peers.remove(viewerId);
        if (peer != null) {
            try { peer.close(); } catch (Exception ignored) { }
            try { peer.dispose(); } catch (Exception ignored) { }
        }
    }

    public void stop() {
        closed = true;
        executor.execute(() -> {
            for (String viewerId : new ArrayList<>(peers.keySet())) closePeer(viewerId);
            try { if (signaling != null) signaling.close(); } catch (Exception ignored) { }
            try { if (videoSource != null && videoStarted) videoSource.getCapturerObserver().onCapturerStopped(); } catch (Exception ignored) { }
            try { if (audioTrack != null) audioTrack.dispose(); } catch (Exception ignored) { }
            try { if (audioSource != null) audioSource.dispose(); } catch (Exception ignored) { }
            try { if (videoTrack != null) videoTrack.dispose(); } catch (Exception ignored) { }
            try { if (videoSource != null) videoSource.dispose(); } catch (Exception ignored) { }
            try { if (factory != null) factory.dispose(); } catch (Exception ignored) { }
            try { if (eglBase != null) eglBase.release(); } catch (Exception ignored) { }
            executor.shutdown();
        });
    }

    private String liveServerUrl(SharedPreferences prefs) {
        String fallback = prefs.getString("serverUrl", "https://shied.onrender.com");
        String live = prefs.getString("liveServerUrl", fallback);
        return (live == null || live.length() == 0 ? fallback : live).replaceAll("/$", "");
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sessionDescription) { }
        @Override public void onSetSuccess() { }
        @Override public void onCreateFailure(String error) { }
        @Override public void onSetFailure(String error) { }
    }
}