# syntax=docker/dockerfile:1.7

# Install all deps (incl. dev) and compile native modules (better-sqlite3).
FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci

# Build the React Router app.
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Runtime image: ships the toolbox the agent's bash tool typically reaches for
# (python, ssh, jq, build chain, archive utils). Keep this aligned with the
# README "컨테이너에 들어있는 도구" table.
FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache \
        bash \
        bind-tools \
        ca-certificates \
        cmake \
        curl \
        exiftool \
        ffmpeg \
        g++ \
        gawk \
        gcc \
        ghostscript \
        git \
        htop \
        imagemagick \
        jq \
        make \
        miller \
        musl-dev \
        mysql-client \
        netcat-openbsd \
        nmap \
        openssh \
        openssl \
        p7zip \
        pandoc \
        patch \
        postgresql-client \
        py3-pip \
        python3 \
        rsync \
        sqlite \
        tini \
        tree \
        tzdata \
        unzip \
        vim \
        wget \
        xmlstarlet \
        xz \
        yq \
        zip \
    && adduser -D -u 10001 piuser \
    && mkdir -p /app/data \
    && chown -R piuser:piuser /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
COPY --from=deps --chown=piuser:piuser /app/node_modules ./node_modules
COPY --from=build --chown=piuser:piuser /app/build ./build
COPY --chown=piuser:piuser package.json package-lock.json ./
USER piuser
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
