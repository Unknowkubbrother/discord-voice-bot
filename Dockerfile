# Bun runtime
FROM oven/bun:1.3.6

WORKDIR /app

# ติดตั้งของระบบที่ต้องใช้:
# - ffmpeg: แปลง/encode เสียง
# - yt-dlp: ดึงเสียงจาก YouTube
# - ca-certificates: TLS
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    yt-dlp \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# copy deps ก่อนเพื่อให้ cache เร็ว
COPY package.json bun.lockb* ./

# install node deps
RUN bun install --frozen-lockfile || bun install

# copy source code
COPY . .

# รันบอท
CMD ["bun", "run", "src/index.ts"]
