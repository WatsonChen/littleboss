# little boss

開發代號。手機優先的 AI 協作工作中心：你是老闆，多位 AI 員工（Claude、ChatGPT、Gemini…）彼此討論與交叉檢核，你核准後再交付。

> 狀態：M0／M1 準備中。正式產品名稱未定。

## 結構

```
apps/web         React + Vite PWA（只透過 API 與後端溝通）
apps/api         Fastify 後端（模型 API 金鑰只存在這裡）
packages/shared  共用契約：型別、zod 驗證、列舉（不含執行邏輯）
```

邊界規則（由 ESLint 強制）：`apps/web` 與 `apps/api` 互不引用；`packages/shared` 不依賴 apps。
`apps/web/src/api.ts` 不依賴 React，之後若改用 React Native 可原樣沿用。

## 開發

需要 Node 22 與 pnpm 10。

```bash
pnpm install
cp .env.example apps/api/.env   # 填入自己的值；不要提交（`pnpm dev:api` 會自動讀取）
pnpm --filter @littleboss/api db:migrate   # 第一次，或有新的 migration 時
pnpm dev:api                    # http://localhost:8787/health
pnpm dev:web                    # http://localhost:5173
```

本地至少要在 `apps/api/.env` 設 `DATABASE_URL`（建議用另一個 Neon branch 或本地 Postgres，不要連正式資料庫）。
不想花錢、也不想申請金鑰時，加上 `LB_FAKE_PROVIDERS=1`：三位 AI 都會回標示清楚的示範回覆。
本地沒設 `ACCESS_TOKEN` 就不需要登入。需要 Node 22.9 以上（讀取 `.env` 用 `--env-file-if-exists`）。

本地 Postgres 範例：

```bash
docker run -d --name lb-pg -p 5432:5432 -e POSTGRES_USER=littleboss -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=littleboss postgres:16
# DATABASE_URL=postgres://littleboss:dev@localhost:5432/littleboss
```

檢查（CI 跑同一組）：

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 安全

- 這是公開 repo。任何金鑰、`.env`、個人資料都不得提交；請啟用 GitHub secret scanning 與 push protection。
- 前端環境變數（`VITE_` 開頭）會被打包進瀏覽器，只能放公開值。
