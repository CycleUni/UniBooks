# UniBooks 本地 Docker 開發環境

讓 `UniBooks-BE`（Django 後端）、`UniBooks-FE`（Angular 22 前端）、`CFEdgeChat`（Cloudflare Workers 即時聊天微服務）、`ISBNnet Resolver`（國家圖書館 ISBN 查詢 Worker）四個專案一鍵在本地 Docker 中運行。

## 結構

```
UniBooks/                       <- 本倉庫（submodule 容器）
├── .env.docker                 <- 所有服務共用的環境變數範本
├── .dockerignore
├── docker-compose.yml          <- Docker Compose 編配
├── docker/
│   ├── Dockerfile.backend      <- BE 映像（基於 python:3.14-slim）
│   ├── Dockerfile.frontend     <- FE 映像（基於 node:24.15.0-bookworm-slim）
│   ├── Dockerfile.cfedgechat   <- Chat 映像（基於 node:24.15.0-bookworm-slim）
│   ├── Dockerfile.isbnnet-resolver <- ISBN 查詢映像（基於 node:24.15.0-bookworm-slim）
│   ├── entrypoint.backend.sh
│   ├── entrypoint.frontend.sh
│   ├── entrypoint.cfedgechat.sh
│   └── entrypoint.isbnnet-resolver.sh
├── UniBooks-BE/                <- submodule（github.com/CycleUni/UniBooks-BE）
├── UniBooks-FE/                <- submodule（github.com/CycleUni/UniBooks-FE）
├── CFEdgeChat/                 <- submodule（github.com/CycleUni/CFEdgeChat）
└── ISBN Search Proxy/ISBNnet Resolver/ <- submodule（github.com/CycleUni/ISBNnet-Resolver）
```

**各子專案保持完全乾淨** — 所有 Docker 設定檔都只放在本倉庫內。

## 啟動

```bash
# 確認三個 submodule 已 init
git submodule update --init --recursive

# 啟動所有服務
docker compose up
```

首次啟動會建構四個映像（每個約 1-3 分鐘），之後啟動只需數秒。

## 服務埠

| 服務 | 容器內 | 主機 | 說明 |
|---|---|---|---|
| 前端 Angular dev server | 4200 | http://localhost:4200 | 熱重載 |
| 後端 Django dev server | 8000 | http://localhost:8000 | 熱重載 + SQLite/Postgres |
| CFEdgeChat | 8787 | http://localhost:8787 | Wrangler dev（模擬 Durable Objects） |
| ISBNnet Resolver | 8789 | http://localhost:8789 | Wrangler dev |
| PostgreSQL | 5432 | localhost:5432 | 資料持久化在 `postgres_data` volume |
| Redis | 6379 | localhost:6379 | 快取、限流、JWT 白名單 |

所有埠只綁定 `127.0.0.1`：後端以 `DEBUG=True` 和範本裡公開的開發用密鑰執行，不應對區域網路開放。

## 互動

```bash
# 查看 logs
docker compose logs -f backend
docker compose logs -f frontend

# 進入容器
docker compose exec backend python manage.py createsuperuser
docker compose exec backend python manage.py shell
docker compose exec db psql -U unibooks -d unibooks

# 重建映像（更新 Dockerfile 或依賴後）
docker compose build --no-cache

# 停止並清除（保留 postgres 資料）
docker compose down

# 連同資料庫一起清除
docker compose down -v
```

## 子模組更新

由於源碼是 bind-mount 進容器（在 `docker-compose.yml` 用 `./UniBooks-BE:/app`），本地修改會即時生效（無需重啟）。要拉取上游更新：

```bash
git submodule update --remote UniBooks-BE
```

## 自訂環境變數

複製 `.env.docker` 為 `.env` 並修改。每個服務先讀 `.env.docker`，再讀（存在的話）`.env`，同名變數以 `.env` 為準：

```bash
cp .env.docker .env
# 編輯 .env
docker compose up
```

注意：`DEBUG` 預設 `True`，會啟用 SQLite / LocMemCache / console email 等 dev fallback。要改用 Postgres / Redis / 真的寄信，只需在 `.env` 中填入對應值即可。

## 管理員帳號

Django 的 `accounts.apps._create_default_superuser` 只在 `DEBUG=False` 時觸發（見 `UniBooks-BE/accounts/apps.py:33`），而本地 docker 環境預設 `DEBUG=True`，所以管理員帳號**不會**自動建立。

第一次啟動後手動建立：

```bash
docker compose exec backend python manage.py createsuperuser \
  --email admin@unibooks.com \
  --first_name Admin \
  --noinput
```

接著設定密碼：

```bash
docker compose exec backend python manage.py shell -c "
from django.contrib.auth import get_user_model
u = get_user_model().objects.get(email='admin@unibooks.com')
u.set_password('admin123')
u.save()
print('password set')
"
```

或用 Django admin（`http://localhost:8000/admin/`）設定密碼。
