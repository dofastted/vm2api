# 槽位出口代理

代理池支持 SOCKS5、HTTP、HTTPS，及已有的本地网络出口。旧记录和不带协议前缀的导入行继续使用 SOCKS5。

可导入以下形式（账密中的特殊字符请使用 URL 编码）：

```text
socks5://user:pass@host:1080
http://user:pass@host:8080
https://user:pass@host:8443
```

HTTP 默认端口为 80，HTTPS 默认端口为 443。HTTP / HTTPS 需要代理服务器支持 CONNECT 隧道，支持免认证或用户名、密码 Basic 认证。

HTTPS 类型表示到代理服务器的连接使用 TLS，并验证服务器证书。HTTP 类型同样可以访问 HTTPS 网站，目标网站的 TLS 在 CONNECT 隧道中建立。

在「编辑代理」中选择代理类型后保存，系统自动更新绑定槽位的配置、出口服务和运行中的 worker，无需手动解绑或重启。现有连接可能短暂中断；页面会报告出口或个别槽位更新失败，便于重试。已停止的槽位在下次启动时使用新配置。

一些代理供应商只允许 CONNECT 到 443 端口，因此不能保证支持任意 TCP 端口。DNS 优先使用现有 DoH 路径；DNS-over-TCP 回退需要供应商允许连接 53 端口。本功能不增加通用 UDP 转发能力。

HTTP / HTTPS 健康探测会尝试 CONNECT 到 `api.anthropic.com:443`，认证失败、TLS 证书错误及 CONNECT 被拒都会报告失败。
