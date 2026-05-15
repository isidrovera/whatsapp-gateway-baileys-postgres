FROM node:22-alpine

WORKDIR /app

# Dependencias necesarias para npm install / Baileys / Prisma
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    openssl \
    libc6-compat

COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY prisma ./prisma

RUN npm install

COPY src ./src

RUN npx prisma generate
RUN npm run build

EXPOSE 3105

CMD ["sh", "-c", "npx prisma db push && node dist/server.js"]