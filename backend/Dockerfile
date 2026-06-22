# backend/Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies required for headless screen capturing and clipboard hooks
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xclip \
    libx11-dev \
    libxtst-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . /app/

ENV SECURE_PASSWORD=your_secure_password
ENV SECRET_KEY=change_this_in_production
ENV HOST=0.0.0.0
ENV PORT=8000

EXPOSE 8000

# Wrap execution inside xvfb virtual display container (1280x720 24-bit color)
CMD ["xvfb-run", "--server-args=-screen 0 1280x720x24", "python", "main.py"]
