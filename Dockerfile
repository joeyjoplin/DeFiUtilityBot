FROM node:20-bullseye

# Install Python 3.11 (Agents SDK needs Python >= 3.10)
RUN apt-get update \
  && apt-get install -y --no-install-recommends software-properties-common curl ca-certificates gnupg \
  && add-apt-repository ppa:deadsnakes/ppa \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3.11 python3.11-distutils python3.11-venv \
  && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.11 \
  && ln -sf /usr/bin/python3.11 /usr/local/bin/python3.11 \
  && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
  && ln -sf /usr/local/bin/pip3.11 /usr/local/bin/pip3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Node deps (server) ----
COPY backend/server/package*.json ./backend/server/
RUN cd backend/server && npm ci

# ---- Python deps (agents) ----
COPY backend/agents/requirements.txt ./backend/agents/requirements.txt
RUN python3.11 -m pip install --no-cache-dir -r backend/agents/requirements.txt

# Copy the rest of the repo
COPY . .

# Render injects PORT
ENV NODE_ENV=production
ENV PYTHON_BIN=python3.11

WORKDIR /app/backend/server
CMD ["node", "server.js"]
