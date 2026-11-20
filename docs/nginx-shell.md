# 终端 WebSocket 排查

集群页、VM 详情「运维」和 Gemini 账号详情「启动 Gemini」都通过浏览器 WebSocket 打开终端。nginx 没把 `Upgrade` 原样交给 Node 时，面板显示「已断开」或「连接失败」，xterm 资源本身仍可能是 200。

终端路径：

| 页面 | 路径 |
|---|---|
| 集群节点 | `/api/panel/cluster/nodes/<id>/shell` |
| 槽运维 | `/api/panel/vms/<id>/shell` |
| Gemini | `/api/panel/gemini/environments/<id>/terminal/ws` |

握手不使用 `Authorization`。面板先 `POST` 对应的 `shell-ticket`（Gemini 使用 `terminal-ticket`），再把短时、一次性的 `ticket` 放在 WebSocket 查询串上。ticket 用过或过期再握手，返回 401。

## 正确反代

终端的 `location` 必须匹配相应路径，而不是落入设置 `Connection ""` 的 `location /` 或 `location /api/`。`Connection ""` 会剥掉 `Upgrade`，Node 收不到握手请求。

只有 Node、没有前门时，`proxy_pass` 指 Node（Compose 默认 `:8787`）：

```nginx
location ~ ^/api/panel/((cluster/nodes|vms)/[^/]+/shell|gemini/environments/[^/]+/terminal/ws)$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

生产机前面还有 Go 前门 `:8787`，Node 在 `:8788`。前门会丢掉 `Upgrade`。shell 必须直连 Node，不要指 `:8787`：

```nginx
location ~ ^/api/panel/((cluster/nodes|vms)/[^/]+/shell|gemini/environments/[^/]+/terminal/ws)$ {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

改完 `nginx -t`，然后 `systemctl reload nginx`。不要为此重启 `kin-gateway`。

## 握手对不上时看到什么

用面板登录拿到的 ticket 打公网（把 `<id>`、`<ticket>` 换成刚申请的；ticket 打在命令历史里，用完即废）：

```bash
curl -sk -D - -o /dev/null \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://<域名>/api/panel/vms/<id>/shell?ticket=<ticket>"
```

| 状态行 | 含义 |
|---|---|
| `101 Switching Protocols` | nginx 已把 Upgrade 交给 Node |
| `401`，`Connection: keep-alive`，正文 `missing_api_key` | 没进 shell location，落到了普通 `/api/`。Go 前门或 Node 把它当成要登录的 HTTP 请求 |
| `401`，且 location 已匹配 | ticket 空、过期或用过。重新申请对应终端的 ticket |
| `502` / `504` | `proxy_pass` 指错端口，或 Node 没在听 |

再确认实际生效的是哪一段：

```bash
nginx -T 2>/dev/null | grep -n shell
```

生产机上这一段的 `proxy_pass` 必须是 `127.0.0.1:8788`。

## 和页面资源分开看

「连不上」和「页面没加载」不是同一件事。

```bash
# 控制台入口。应有 <title>vm2api</title> 和 id="root"
curl -sk -o /dev/null -w '%{http_code}\n' https://<域名>/

# 终端脚本。文件名以线上 index 的引用为准，应 200，Content-Type 含 javascript
grep -o 'assets/ws-terminal[^"]*' /var/www/kin-console/index.html
```

这两个 200，但握手不是 101：只查 nginx location，不用重编 `web/dist`，也不用重启 Node。
