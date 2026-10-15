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
cp .env.example apps/api/.env   # 填入自己的值；不要提交
pnpm dev:api                    # http://localhost:8787/health
pnpm dev:web
```

檢查（CI 跑同一組）：

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## 安全

- 這是公開 repo。任何金鑰、`.env`、個人資料都不得提交；請啟用 GitHub secret scanning 與 push protection。
- 前端環境變數（`VITE_` 開頭）會被打包進瀏覽器，只能放公開值。
