package com.cpdevice.agent;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import javax.net.ssl.SSLSocketFactory;
import java.net.URI;
import java.util.Base64;
import java.util.Random;

public class SimpleWebSocketClient {
    public interface Listener {
        void onText(String text);
        void onClosed();
    }

    private Socket socket;
    private OutputStream output;
    private InputStream input;
    private Listener listener;
    private Thread readerThread;
    private volatile boolean running;

    public synchronized void setListener(Listener listener) {
        this.listener = listener;
    }

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
        input = socket.getInputStream();
        StringBuilder response = new StringBuilder();
        int previous = 0, current;
        while ((current = input.read()) >= 0) {
            response.append((char) current);
            if (previous == '\r' && current == '\n' && response.toString().endsWith("\r\n\r\n")) break;
            previous = current;
        }
        if (!response.toString().contains("101")) throw new IllegalStateException("WebSocket upgrade failed");
        startReader();
    }

    public synchronized void sendText(String text) throws Exception {
        sendFrame((byte) 0x81, text.getBytes("UTF-8"));
    }

    public synchronized void sendBinary(byte[] payload) throws Exception {
        sendFrame((byte) 0x82, payload);
    }

    private synchronized void sendFrame(byte opcode, byte[] payload) throws Exception {
        if (socket == null || socket.isClosed() || output == null) return;
        byte[] mask = new byte[4];
        new Random().nextBytes(mask);
        output.write(opcode);
        if (payload.length < 126) output.write(0x80 | payload.length);
        else if (payload.length < 65536) { output.write(0x80 | 126); output.write((payload.length >> 8) & 255); output.write(payload.length & 255); }
        else throw new IllegalArgumentException("Frame too large");
        output.write(mask);
        for (int i = 0; i < payload.length; i++) output.write(payload[i] ^ mask[i % 4]);
        output.flush();
    }

    private void startReader() {
        running = true;
        readerThread = new Thread(() -> {
            try {
                while (running && socket != null && !socket.isClosed()) readFrame();
            } catch (Exception ignored) {
            } finally {
                running = false;
                Listener current = listener;
                if (current != null) current.onClosed();
            }
        }, "shield-ws-reader");
        readerThread.start();
    }

    private void readFrame() throws Exception {
        int first = input.read();
        int second = input.read();
        if (first < 0 || second < 0) throw new IllegalStateException("closed");
        int opcode = first & 0x0f;
        int length = second & 0x7f;
        if (length == 126) length = (input.read() << 8) | input.read();
        else if (length == 127) {
            long longLength = 0;
            for (int i = 0; i < 8; i++) longLength = (longLength << 8) | input.read();
            if (longLength > Integer.MAX_VALUE) throw new IllegalArgumentException("Frame too large");
            length = (int) longLength;
        }
        boolean masked = (second & 0x80) != 0;
        byte[] mask = new byte[4];
        if (masked) readFully(mask, 0, 4);
        byte[] payload = new byte[length];
        readFully(payload, 0, length);
        if (masked) for (int i = 0; i < payload.length; i++) payload[i] = (byte) (payload[i] ^ mask[i % 4]);
        if (opcode == 8) throw new IllegalStateException("closed");
        if (opcode == 9) { sendFrame((byte) 0x8A, payload); return; }
        if (opcode == 1) {
            Listener current = listener;
            if (current != null) current.onText(new String(payload, "UTF-8"));
        }
    }

    private void readFully(byte[] buffer, int offset, int length) throws Exception {
        int read = 0;
        while (read < length) {
            int count = input.read(buffer, offset + read, length - read);
            if (count < 0) throw new IllegalStateException("closed");
            read += count;
        }
    }

    public synchronized void close() {
        running = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null;
        output = null;
        input = null;
    }
}