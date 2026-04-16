# Base: minimal Node image for Next.js
FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

RUN npm ci

# Copy source and build Next.js
COPY . .
RUN npm run build

ENV NODE_ENV=production

# Next.js reads PORT env var automatically (injected by Railway)
EXPOSE 3000

CMD ["npm", "start"]
