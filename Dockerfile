# Base: official Playwright image — has Chromium + all system deps pre-installed
FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Skip Playwright browser auto-download during npm ci (we install manually below)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# Install Chromium for this exact Playwright version
RUN npx playwright install chromium

# Copy source and build Next.js
COPY . .
RUN npm run build

ENV NODE_ENV=production

# Next.js reads PORT env var automatically (injected by Railway)
EXPOSE 3000

CMD ["npm", "start"]
