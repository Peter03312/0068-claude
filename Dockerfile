# 构建阶段：装全部依赖（含 devDependencies），跑单测与生产构建
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Playwright Chromium 运行所需系统库（verify 服务用）
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

# 单元/领域测试
RUN npm run test:run

# 类型检查 + 生产构建
RUN npm run build

# 预装 Playwright Chromium（供 verify 服务跑端到端验收），装到 /app 内一并带入下一阶段
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.pw-browsers
RUN npx playwright install --with-deps chromium

# 静态文件与验收共用的运行阶段（verify 也在此镜像内跑测试）
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.pw-browsers
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl bash \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g serve@14

# 复制整个构建上下文（含源码、依赖、Playwright 浏览器与 dist）
COPY --from=build /app /app

EXPOSE 4173

# 默认命令：常驻 web（预览生产构建）。
# APP_PORT 只影响宿主映射（见 docker-compose.yml）；容器内固定监听 4173。
CMD ["serve", "-s", "dist", "-l", "4173"]
