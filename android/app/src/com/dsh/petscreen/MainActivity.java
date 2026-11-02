package com.dsh.petscreen;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.text.InputType;
import android.view.Window;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 全屏鲸鱼娘：首次连接把动画下载到本机，之后由内置本地 HTTP 服务提供，
 * 只有状态/会话仍走局域网，不再反复拉视频。
 */
public class MainActivity extends Activity {
    private static final String TAG = "PetScreen";
    private static final String DEFAULT_URL = "__DEFAULT_URL__";
    private static final String ASSET_VERSION_KEY = "assetVersion";

    private WebView web;
    private FrameLayout root;
    private LinearLayout overlay;
    private TextView overlayTitle;
    private TextView overlayDetail;
    private ProgressBar progressBar;
    private Button retryButton;
    private Button skipButton;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private AssetServer assetServer;
    private SharedPreferences configPrefs;
    private String targetUrl;
    private String baseUrl;
    private String token;
    private String serverHost;
    private int serverPort;
    private boolean whisperOn = true;
    private String uiTheme = "";
    private long lastUiUpdate = 0L;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (getActionBar() != null) getActionBar().hide();

        String initialUrl = getIntent().getStringExtra("url");
        if (initialUrl == null || initialUrl.isEmpty()) initialUrl = DEFAULT_URL;
        Uri uri = Uri.parse(initialUrl);
        serverHost = uri.getHost() == null ? "" : uri.getHost();
        serverPort = uri.getPort() > 0 ? uri.getPort() : 39100;
        token = uri.getQueryParameter("t");
        if (token == null) token = "";

        configPrefs = getSharedPreferences("config", MODE_PRIVATE);
        String savedHost = configPrefs.getString("host", "");
        if (!savedHost.isEmpty()) {
            serverHost = savedHost;
            serverPort = configPrefs.getInt("port", 39100);
            token = configPrefs.getString("token", token);
            whisperOn = configPrefs.getBoolean("whisper", true);
            uiTheme = configPrefs.getString("uiTheme", "");
        }
        targetUrl = buildTargetUrl();
        baseUrl = "http://" + serverHost + ":" + serverPort;

        buildUi();
        hideSystemUi();
        beginSync();
    }

    private void buildUi() {
        root = new FrameLayout(this);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        web.addJavascriptInterface(new HostBridge(), "DshHost");

        WebView.setWebContentsDebuggingEnabled(true);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setGravity(Gravity.CENTER);
        overlay.setBackgroundColor(Color.rgb(242, 243, 245));
        overlay.setPadding(dp(32), dp(32), dp(32), dp(32));

        overlayTitle = new TextView(this);
        overlayTitle.setText("首次准备离线动画");
        overlayTitle.setTextColor(Color.rgb(35, 50, 70));
        overlayTitle.setTextSize(20);
        overlayTitle.setGravity(Gravity.CENTER);
        overlay.addView(overlayTitle, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        overlayDetail = new TextView(this);
        overlayDetail.setText("正在检查本地动画…");
        overlayDetail.setTextColor(Color.rgb(91, 111, 137));
        overlayDetail.setTextSize(13);
        overlayDetail.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams detailLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        detailLp.topMargin = dp(12);
        overlay.addView(overlayDetail, detailLp);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(1000);
        progressBar.setProgress(0);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(10));
        barLp.topMargin = dp(20);
        overlay.addView(progressBar, barLp);

        retryButton = new Button(this);
        retryButton.setText("重试下载");
        retryButton.setVisibility(View.GONE);
        retryButton.setOnClickListener(v -> beginSync());
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        retryLp.topMargin = dp(20);
        retryLp.gravity = Gravity.CENTER;
        overlay.addView(retryButton, retryLp);

        skipButton = new Button(this);
        skipButton.setText("先在线使用");
        skipButton.setVisibility(View.GONE);
        skipButton.setOnClickListener(v -> loadOnline());
        LinearLayout.LayoutParams skipLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        skipLp.topMargin = dp(8);
        skipLp.gravity = Gravity.CENTER;
        overlay.addView(skipButton, skipLp);

        root.addView(overlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void beginSync() {
        lastUiUpdate = 0L;
        runOnUiThread(() -> {
            overlay.setVisibility(View.VISIBLE);
            overlayTitle.setText("首次准备离线动画");
            overlayDetail.setText("正在检查本地动画…");
            progressBar.setVisibility(View.VISIBLE);
            progressBar.setProgress(0);
            retryButton.setVisibility(View.GONE);
            skipButton.setVisibility(View.GONE);
        });

        io.execute(() -> {
            try {
                String manifestUrl = baseUrl + "/api/assets?t=" + Uri.encode(token);
                JSONObject manifest = fetchJson(manifestUrl);
                String version = manifest.getString("version");
                JSONArray files = manifest.getJSONArray("files");
                long totalBytes = manifest.getLong("totalBytes");
                File assetRoot = new File(getFilesDir(), "anim");
                SharedPreferences prefs = getSharedPreferences("assets", MODE_PRIVATE);

                boolean complete = version.equals(prefs.getString(ASSET_VERSION_KEY, ""))
                        && allFilesPresent(files, assetRoot);
                if (complete) {
                    runOnUiThread(() -> overlayDetail.setText("本地动画已就绪"));
                    startLocalAndLoad();
                    return;
                }

                downloadAll(files, totalBytes, assetRoot);
                prefs.edit().putString(ASSET_VERSION_KEY, version).apply();
                startLocalAndLoad();
            } catch (Exception error) {
                Log.w(TAG, "asset sync failed", error);
                runOnUiThread(() -> showError(error));
            }
        });
    }

    private boolean allFilesPresent(JSONArray files, File assetRoot) {
        for (int i = 0; i < files.length(); i++) {
            try {
                JSONObject file = files.getJSONObject(i);
                File target = new File(assetRoot, file.getString("theme") + "/"
                        + file.getString("name") + ".mp4");
                if (!target.isFile() || target.length() != file.getLong("size")) return false;
            } catch (Exception error) {
                return false;
            }
        }
        return true;
    }

    private void downloadAll(JSONArray files, long totalBytes, File assetRoot) throws Exception {
        long started = System.currentTimeMillis();
        long done = 0L;
        for (int i = 0; i < files.length(); i++) {
            JSONObject file = files.getJSONObject(i);
            String theme = file.getString("theme");
            String name = file.getString("name");
            long size = file.getLong("size");
            File dir = new File(assetRoot, theme);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建目录 " + dir);
            File target = new File(dir, name + ".mp4");

            if (target.isFile() && target.length() == size) {
                done += size;
                reportProgress(done, totalBytes, i + 1, files.length(), started);
                continue;
            }

            String url = baseUrl + "/" + theme + "/" + Uri.encode(name) + ".mp4?t=" + Uri.encode(token);
            File part = new File(dir, name + ".mp4.part");
            if (part.exists() && !part.delete()) throw new IOException("无法清理临时文件");
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setRequestProperty("Accept-Encoding", "identity");
            try {
                int code = connection.getResponseCode();
                if (code != 200) throw new IOException("下载失败 HTTP " + code + " · " + name);
                try (InputStream in = new BufferedInputStream(connection.getInputStream());
                     OutputStream out = new BufferedOutputStream(new FileOutputStream(part))) {
                    byte[] buffer = new byte[64 * 1024];
                    long local = 0L;
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                        local += read;
                        reportProgress(done + local, totalBytes, i + 1, files.length(), started);
                    }
                    out.flush();
                }
            } finally {
                connection.disconnect();
            }
            if (part.length() != size) throw new IOException("文件大小不符 " + name);
            if (target.exists() && !target.delete()) throw new IOException("无法覆盖 " + target);
            if (!part.renameTo(target)) throw new IOException("无法保存 " + target);
            done += size;
            reportProgress(done, totalBytes, i + 1, files.length(), started);
        }
    }

    private void reportProgress(long done, long total, int index, int count, long started) {
        long now = System.currentTimeMillis();
        if (now - lastUiUpdate < 180 && done < total) return;
        lastUiUpdate = now;
        long elapsed = Math.max(1L, now - started);
        double speed = done / 1024.0 / 1024.0 / (elapsed / 1000.0);
        int percent = total > 0 ? (int) Math.min(100, done * 100 / total) : 0;
        long doneMb = done / 1024 / 1024;
        long totalMb = total / 1024 / 1024;
        runOnUiThread(() -> {
            progressBar.setProgress(percent * 10);
            overlayDetail.setText(percent + "% · " + index + "/" + count
                    + " · " + doneMb + "/" + totalMb + " MB"
                    + " · " + String.format("%.1f", speed) + " MB/s");
        });
    }

    private JSONObject fetchJson(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("Accept", "application/json");
        try {
            int code = connection.getResponseCode();
            InputStream in = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (in == null) throw new IOException("HTTP " + code);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            in.close();
            if (code != 200) throw new IOException("HTTP " + code + " " + out.toString("UTF-8"));
            return new JSONObject(out.toString("UTF-8"));
        } finally {
            connection.disconnect();
        }
    }

    private void startLocalAndLoad() {
        try {
            if (assetServer == null) {
                assetServer = new AssetServer(new File(getFilesDir(), "anim"));
                assetServer.start();
            }
            String assetBase = assetServer.baseUrl();
            String url = targetUrl + (targetUrl.contains("?") ? "&" : "?")
                    + "assetBase=" + Uri.encode(assetBase);
            runOnUiThread(() -> {
                overlay.setVisibility(View.GONE);
                web.loadUrl(url);
            });
        } catch (Exception error) {
            Log.w(TAG, "local server failed", error);
            runOnUiThread(() -> {
                overlay.setVisibility(View.GONE);
                web.loadUrl(targetUrl);
            });
        }
    }

    private void loadOnline() {
        overlay.setVisibility(View.GONE);
        web.loadUrl(targetUrl);
    }

    private void showError(Exception error) {
        overlay.setVisibility(View.VISIBLE);
        overlayTitle.setText("离线动画下载失败");
        overlayDetail.setText(String.valueOf(error.getMessage()));
        progressBar.setVisibility(View.GONE);
        retryButton.setVisibility(View.VISIBLE);
        skipButton.setVisibility(View.VISIBLE);
    }


    private String buildTargetUrl() {
        String url = "http://" + serverHost + ":" + serverPort + "/?t=" + Uri.encode(token);
        if (!whisperOn) url += "&whisper=0";
        if (!uiTheme.isEmpty()) url += "&uiTheme=" + Uri.encode(uiTheme);
        return url;
    }

    private void showConfig() {
        if (configPrefs == null) configPrefs = getSharedPreferences("config", MODE_PRIVATE);

        final Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setCanceledOnTouchOutside(true);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(22), dp(18), dp(22), dp(16));
        card.setBackground(round(Color.rgb(247, 249, 252), 22, 0));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this);
        title.setText("连接设置");
        title.setTextSize(20);
        title.setTextColor(Color.rgb(25, 38, 56));
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        header.addView(title, titleLp);
        TextView close = new TextView(this);
        close.setText("×");
        close.setTextSize(24);
        close.setTextColor(Color.rgb(120, 137, 158));
        close.setGravity(Gravity.CENTER);
        close.setPadding(dp(10), 0, dp(4), dp(4));
        close.setOnClickListener(v -> dialog.dismiss());
        header.addView(close);
        card.addView(header);

        TextView subtitle = new TextView(this);
        subtitle.setText("服务器与显示方式");
        subtitle.setTextSize(12);
        subtitle.setTextColor(Color.rgb(112, 128, 148));
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(2);
        card.addView(subtitle, subLp);

        card.addView(label("服务器 IP / 主机名"));
        EditText hostField = field(serverHost, "例如 192.168.1.212", InputType.TYPE_CLASS_TEXT);
        card.addView(hostField);

        LinearLayout portRow = new LinearLayout(this);
        portRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout portWrap = new LinearLayout(this);
        portWrap.setOrientation(LinearLayout.VERTICAL);
        portWrap.addView(label("端口"));
        EditText portField = field(String.valueOf(serverPort), "39100", InputType.TYPE_CLASS_NUMBER);
        portWrap.addView(portField);
        portRow.addView(portWrap, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        LinearLayout tokenWrap = new LinearLayout(this);
        tokenWrap.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tokenWrapLp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 2f);
        tokenWrapLp.leftMargin = dp(10);
        tokenWrap.addView(label("访问 token"));
        EditText tokenField = field(token, "启动时打印的 token", InputType.TYPE_CLASS_TEXT);
        tokenWrap.addView(tokenField);
        portRow.addView(tokenWrap, tokenWrapLp);
        card.addView(portRow);

        card.addView(label("主题"));
        final String[] selectedTheme = {uiTheme};
        final String[] themeValues = {"", "light", "dark"};
        final String[] themeNames = {"跟随页面", "浅色", "黑灰"};
        LinearLayout segment = new LinearLayout(this);
        segment.setOrientation(LinearLayout.HORIZONTAL);
        segment.setBackground(round(Color.rgb(234, 240, 248), 12, 0));
        segment.setPadding(dp(3), dp(3), dp(3), dp(3));
        final TextView[] options = new TextView[themeNames.length];
        for (int i = 0; i < themeNames.length; i++) {
            final int index = i;
            TextView option = new TextView(this);
            option.setText(themeNames[i]);
            option.setTextSize(13);
            option.setGravity(Gravity.CENTER);
            option.setPadding(0, dp(8), 0, dp(8));
            option.setOnClickListener(v -> {
                selectedTheme[0] = themeValues[index];
                for (int j = 0; j < options.length; j++) {
                    styleSegment(options[j], j == index);
                }
            });
            options[i] = option;
            segment.addView(option, new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        }
        styleSegment(options[Math.max(0, java.util.Arrays.asList(themeValues).indexOf(uiTheme))], true);
        card.addView(segment);

        LinearLayout whisperRow = new LinearLayout(this);
        whisperRow.setOrientation(LinearLayout.HORIZONTAL);
        whisperRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams whisperRowLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        whisperRowLp.topMargin = dp(14);
        TextView whisperTitle = new TextView(this);
        whisperTitle.setText("碎碎念");
        whisperTitle.setTextSize(14);
        whisperTitle.setTextColor(Color.rgb(35, 50, 70));
        whisperRow.addView(whisperTitle, new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        final boolean[] whisperState = {whisperOn};
        final TextView whisperToggle = new TextView(this);
        whisperToggle.setTextSize(12);
        whisperToggle.setTypeface(null, android.graphics.Typeface.BOLD);
        whisperToggle.setGravity(Gravity.CENTER);
        whisperToggle.setPadding(dp(12), dp(6), dp(12), dp(6));
        styleToggle(whisperToggle, whisperState[0]);
        whisperToggle.setOnClickListener(v -> {
            whisperState[0] = !whisperState[0];
            styleToggle(whisperToggle, whisperState[0]);
        });
        whisperRow.addView(whisperToggle);
        card.addView(whisperRow, whisperRowLp);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        actionsLp.topMargin = dp(18);
        TextView cancel = new TextView(this);
        cancel.setText("取消");
        cancel.setTextSize(14);
        cancel.setTextColor(Color.rgb(112, 128, 148));
        cancel.setPadding(dp(14), dp(10), dp(14), dp(10));
        cancel.setOnClickListener(v -> dialog.dismiss());
        actions.addView(cancel);
        TextView save = new TextView(this);
        save.setText("保存并重连");
        save.setTextSize(14);
        save.setTextColor(Color.WHITE);
        save.setTypeface(null, android.graphics.Typeface.BOLD);
        save.setGravity(Gravity.CENTER);
        save.setPadding(dp(18), dp(10), dp(18), dp(10));
        save.setBackground(round(Color.rgb(47, 107, 255), 12, 0));
        save.setOnClickListener(v -> {
            String host = hostField.getText().toString().trim();
            if (host.startsWith("http://")) host = host.substring(7);
            if (host.startsWith("https://")) host = host.substring(8);
            int slash = host.indexOf('/');
            if (slash >= 0) host = host.substring(0, slash);
            if (host.isEmpty()) { hostField.setError("不能为空"); return; }
            int port;
            try {
                port = Integer.parseInt(portField.getText().toString().trim());
            } catch (NumberFormatException error) {
                portField.setError("端口必须是数字");
                return;
            }
            if (port < 1 || port > 65535) { portField.setError("端口范围 1-65535"); return; }
            String newToken = tokenField.getText().toString().trim();
            if (newToken.isEmpty()) { tokenField.setError("token 不能为空"); return; }
            serverHost = host;
            serverPort = port;
            token = newToken;
            whisperOn = whisperState[0];
            uiTheme = selectedTheme[0];
            configPrefs.edit()
                    .putString("host", serverHost)
                    .putInt("port", serverPort)
                    .putString("token", token)
                    .putBoolean("whisper", whisperOn)
                    .putString("uiTheme", uiTheme)
                    .apply();
            targetUrl = buildTargetUrl();
            baseUrl = "http://" + serverHost + ":" + serverPort;
            dialog.dismiss();
            restartWithConfig();
        });
        actions.addView(save);
        card.addView(actions, actionsLp);

        scroll.addView(card);
        dialog.setContentView(scroll);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.width = Math.round(getResources().getDisplayMetrics().widthPixels * 0.9f);
            lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
            lp.dimAmount = 0.45f;
            window.setAttributes(lp);
        }
        dialog.show();
    }

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(11);
        view.setTextColor(Color.rgb(112, 128, 148));
        view.setTypeface(null, android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        lp.bottomMargin = dp(5);
        view.setLayoutParams(lp);
        return view;
    }

    private EditText field(String value, String hint, int inputType) {
        EditText view = new EditText(this);
        view.setText(value);
        view.setHint(hint);
        view.setSingleLine(true);
        view.setInputType(inputType);
        view.setTextSize(15);
        view.setTextColor(Color.rgb(25, 38, 56));
        view.setHintTextColor(Color.rgb(154, 170, 191));
        view.setPadding(dp(12), dp(10), dp(12), dp(10));
        view.setBackground(round(Color.WHITE, 12, Color.rgb(220, 228, 239)));
        return view;
    }

    private GradientDrawable round(int color, int radiusDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) drawable.setStroke(dp(1), strokeColor);
        return drawable;
    }

    private void styleToggle(TextView view, boolean on) {
        view.setText(on ? "开启" : "关闭");
        view.setTextColor(on ? Color.rgb(47, 107, 255) : Color.rgb(112, 128, 148));
        view.setBackground(round(on ? Color.rgb(232, 240, 255) : Color.rgb(234, 240, 248), 999, 0));
    }

    private void styleSegment(TextView view, boolean selected) {
        view.setTextColor(selected ? Color.rgb(47, 107, 255) : Color.rgb(91, 111, 137));
        view.setTypeface(null, selected ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        view.setBackground(selected ? round(Color.WHITE, 9, 0) : null);
    }

    private void restartWithConfig() {
        runOnUiThread(() -> {
            web.loadUrl("about:blank");
            overlay.setVisibility(View.VISIBLE);
            overlayTitle.setText("正在应用配置");
            overlayDetail.setText("检查服务器与本地动画…");
            progressBar.setVisibility(View.VISIBLE);
            progressBar.setProgress(0);
            retryButton.setVisibility(View.GONE);
            skipButton.setVisibility(View.GONE);
            beginSync();
        });
    }

    private class HostBridge {
        @JavascriptInterface
        public int getBatteryLevel() {
            try {
                BatteryManager manager = (BatteryManager) getSystemService(BATTERY_SERVICE);
                int level = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                if (level >= 0 && level <= 100) return level;
                Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                if (battery == null) return -1;
                int raw = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
                return raw >= 0 && scale > 0 ? Math.round(raw * 100f / scale) : -1;
            } catch (Exception error) {
                return -1;
            }
        }

        @JavascriptInterface
        public boolean isCharging() {
            try {
                Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
                if (battery == null) return false;
                int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
                return status == BatteryManager.BATTERY_STATUS_CHARGING
                        || status == BatteryManager.BATTERY_STATUS_FULL;
            } catch (Exception error) {
                return false;
            }
        }

        @JavascriptInterface
        public void openConfig() {
            runOnUiThread(MainActivity.this::showConfig);
        }
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) hideSystemUi();
    }

    @Override
    protected void onDestroy() {
        if (assetServer != null) {
            assetServer.stop();
            assetServer = null;
        }
        io.shutdownNow();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * 极简本地 HTTP 服务：只服务 files/anim 下的 mp4，支持 Range，
     * 让 WebView 的 video 能正常拖动/分段读取。
     */
    private static class AssetServer {
        private final File root;
        private ServerSocket server;
        private Thread acceptThread;
        private volatile boolean running;

        AssetServer(File root) {
            this.root = root;
        }

        void start() throws IOException {
            server = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
            running = true;
            acceptThread = new Thread(() -> {
                while (running) {
                    try {
                        Socket socket = server.accept();
                        Thread worker = new Thread(() -> handle(socket));
                        worker.setDaemon(true);
                        worker.start();
                    } catch (IOException error) {
                        if (running) Log.w(TAG, "asset server accept failed", error);
                    }
                }
            });
            acceptThread.setDaemon(true);
            acceptThread.start();
            Log.i(TAG, "asset server " + baseUrl());
        }

        String baseUrl() {
            return "http://127.0.0.1:" + server.getLocalPort();
        }

        void stop() {
            running = false;
            try {
                if (server != null) server.close();
            } catch (IOException ignored) {
            }
        }

        private void handle(Socket socket) {
            try (Socket s = socket) {
                BufferedInputStream in = new BufferedInputStream(s.getInputStream());
                String requestLine = readLine(in);
                if (requestLine == null || requestLine.isEmpty()) return;
                String range = null;
                String line;
                while ((line = readLine(in)) != null && !line.isEmpty()) {
                    if (line.toLowerCase().startsWith("range:")) range = line.substring(6).trim();
                }

                String[] parts = requestLine.split(" ");
                if (parts.length < 2) return;
                String rawPath = parts[1];
                int queryIndex = rawPath.indexOf('?');
                if (queryIndex >= 0) rawPath = rawPath.substring(0, queryIndex);
                String decoded;
                try {
                    decoded = URLDecoder.decode(rawPath, "UTF-8");
                } catch (Exception error) {
                    sendError(s, 400, "Bad Request");
                    return;
                }
                if (!decoded.startsWith("/light/") && !decoded.startsWith("/dark/")) {
                    sendError(s, 404, "Not Found");
                    return;
                }

                File file = new File(root, decoded.substring(1));
                String canonicalRoot = root.getCanonicalPath();
                if (!file.getCanonicalPath().startsWith(canonicalRoot) || !file.isFile()) {
                    sendError(s, 404, "Not Found");
                    return;
                }

                long size = file.length();
                long start = 0L;
                long end = size - 1;
                boolean partial = false;
                if (range != null && range.startsWith("bytes=")) {
                    String[] bounds = range.substring(6).split("-", -1);
                    try {
                        start = bounds[0].isEmpty() ? 0 : Long.parseLong(bounds[0]);
                        if (bounds.length > 1 && !bounds[1].isEmpty()) end = Long.parseLong(bounds[1]);
                        if (start < 0) start = 0;
                        if (end >= size) end = size - 1;
                        if (start >= size || start > end) {
                            sendError(s, 416, "Range Not Satisfiable");
                            return;
                        }
                        partial = true;
                    } catch (NumberFormatException ignored) {
                        start = 0;
                        end = size - 1;
                    }
                }

                long length = end - start + 1;
                OutputStream out = s.getOutputStream();
                StringBuilder head = new StringBuilder();
                head.append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
                head.append("Content-Type: video/mp4\r\n");
                head.append("Accept-Ranges: bytes\r\n");
                head.append("Access-Control-Allow-Origin: *\r\n");
                head.append("Content-Length: ").append(length).append("\r\n");
                head.append("Connection: close\r\n");
                if (partial) {
                    head.append("Content-Range: bytes ").append(start).append("-")
                            .append(end).append("/").append(size).append("\r\n");
                }
                head.append("\r\n");
                out.write(head.toString().getBytes(StandardCharsets.US_ASCII));

                if ("HEAD".equals(parts[0])) {
                    out.flush();
                    return;
                }
                try (FileInputStream fileIn = new FileInputStream(file)) {
                    long skipped = 0L;
                    while (skipped < start) {
                        long step = fileIn.skip(start - skipped);
                        if (step <= 0) break;
                        skipped += step;
                    }
                    byte[] buffer = new byte[64 * 1024];
                    long remaining = length;
                    while (remaining > 0) {
                        int read = fileIn.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (read <= 0) break;
                        out.write(buffer, 0, read);
                        remaining -= read;
                    }
                    out.flush();
                }
            } catch (Exception error) {
                Log.w(TAG, "asset server request failed", error);
            }
        }

        private String readLine(InputStream in) throws IOException {
            ByteArrayOutputStream line = new ByteArrayOutputStream();
            int b;
            while ((b = in.read()) >= 0) {
                if (b == '\n') break;
                if (b != '\r') line.write(b);
                if (line.size() > 4096) break;
            }
            return line.size() == 0 ? null : line.toString("UTF-8");
        }

        private void sendError(Socket socket, int code, String reason) {
            try {
                String body = code + " " + reason;
                String head = "HTTP/1.1 " + code + " " + reason + "\r\n"
                        + "Content-Type: text/plain\r\n"
                        + "Content-Length: " + body.length() + "\r\n"
                        + "Connection: close\r\n\r\n";
                OutputStream out = socket.getOutputStream();
                out.write((head + body).getBytes(StandardCharsets.US_ASCII));
                out.flush();
            } catch (IOException ignored) {
            }
        }
    }
}
