FROM node:20-bullseye

# Install Python (needed for spawn python3 m2m_client.py)
RUN apt-get update \
  && apt-get install -y python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Node deps (server) ----
COPY backend/server/package*.json ./backend/server/
RUN cd backend/server && npm ci

# ---- Python deps (agents) ----
COPY backend/agents/requirements.txt ./backend/agents/requirements.txt
RUN python3 -m pip install --no-cache-dir -r backend/agents/requirements.txt

# Copy the rest of the repo
COPY . .

# Render injects PORT
ENV NODE_ENV=production
ENV PYTHON_BIN=python3

WORKDIR /app/backend/server
CMD ["node", "server.js"]
