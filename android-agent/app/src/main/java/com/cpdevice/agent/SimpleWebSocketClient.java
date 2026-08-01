package com.cpdevice.agent;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import javax.net.ssl.SSLSocketFactory;
import java.net.URI;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Random;

public class SimpleWebSocketClient {
    private Socket socket;
    private OutputStream output;

    public synchronized void connect(String wsUrl) throws Exception {
        URI uri = URI.create(wsUrl);
        int port = uri.getPort() > 0 ? uri.getPort() : ("wss".equals(uri.getScheme()) ? 443 : 80);
        socket = "wss".equals(uri.getScheme()) ? SSLSocketFactory.getDefault().createSocket(uri.getHost(), port) : new Socket(uri.getHost(), port);
        output = socket.getOutputStream();
        String key = Base64.getEncoder().encodeToString(("cp" + System.nanoTime()).getBytes());
        String path = uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        String request = "GET " + path + " HTTP/1.1\r\nHost: " + uri.getHost() + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        output.write(request.getBytes());
        output.flush();
        InputStream input = socket.getInputStream();
        StringBuilder response = new StringBuilder();
        int previous = 0, current;
        while ((current = input.read()) >= 0) {
            response.append((char) current);
            if (previous == '\r' && current == '\n' && response.toString().endsWith("\r\n\r\n")) break;
            previous = current;
        }
        if (!response.toString().contains("101")) throw new IllegalStateException("WebSocket upgrade failed");
    }

    public synchronized void sendBinary(byte[] payload) throws Exception {
        if (socket == null || socket.isClosed()) return;
        byte[] mask = new byte[4];
        new Random().nextBytes(mask);
        output.write(0x82);
        if (payload.length < 126) output.write(0x80 | payload.length);
        else if (payload.length < 65536) { output.write(0x80 | 126); output.write((payload.length >> 8) & 255); output.write(payload.length & 255); }
        else throw new IllegalArgumentException("Frame too large");
        output.write(mask);
        for (int i = 0; i < payload.length; i++) output.write(payload[i] ^ mask[i % 4]);
        output.flush();
    }

    public synchronized void close() {
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
    }
}
