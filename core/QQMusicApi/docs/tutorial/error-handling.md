# 错误处理

## 异常层级

```text
BaseApiException
├── CredentialInvalidError    # 凭证缺失或格式损坏
├── NetworkError              # 网络异常 (断网、超时)
├── HTTPError                 # HTTP 状态码异常 (含 status_code 属性)
├── ApiDataError              # 响应解析失败
└── ApiException              # 业务异常基类 (含 code 属性)
    ├── GlobalApiError        # 网关级错误
    └── CgiApiException       # 单项 CGI 错误
        ├── CredentialExpiredError   # 凭证过期 (code: 1000/104401/104400)
        ├── CredentialRefreshError   # 凭证刷新失败
        ├── RatelimitedError         # 触发风控 (含 feedback_url 属性)
        └── LoginError               # 登录域错误
```

## 基本用法

大多数场景只需捕获 `BaseApiException`：

```python
from qqmusic_api import Client, BaseApiException

async with Client() as client:
    try:
        result = await client.search.search_by_type("周杰伦")
    except BaseApiException as e:
        print(f"请求失败: {e}")
```

## 分场景处理

如需针对特定错误类型执行不同逻辑：

```python
from qqmusic_api import (
    Client,
    CredentialExpiredError,
    NetworkError,
    RatelimitedError,
)

async with Client() as client:
    try:
        result = await client.song.get_song_urls(...)
    except CredentialExpiredError:
        # 重新登录或刷新凭证
        ...
    except RatelimitedError as e:
        # e.feedback_url 可用于引导用户完成安全验证
        ...
    except NetworkError:
        # 网络不可用，稍后重试
        ...
```

## 常见异常说明

| 异常 | 触发场景 | 建议处理方式 |
| ------ | --------- | ------------- |
| `CredentialInvalidError` | 调用需登录的接口但未提供凭证 | 传入有效的 `Credential` |
| `NetworkError` | 断网、DNS 解析失败、连接超时 | 稍后重试 |
| `HTTPError` | 服务端返回非 200 状态码 | 检查请求地址或重试 |
| `CredentialExpiredError` | musickey 过期 | 调用 `refresh_credential` 或重新登录 |
| `RatelimitedError` | 触发风控 | 引导用户完成 `feedback_url` 中的安全验证 |
| `LoginError` | 登录参数错误、验证码错误、账号受限等 | 检查登录参数或更换登录方式 |
