# Use the official lightweight Node.js 20 image for better security
FROM node:20-slim

# Set the working directory
WORKDIR /usr/src/app

# Install OpenSSL and other required dependencies for Prisma and Cloud Run
RUN apt-get update -y && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssl ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    apt-get clean

# Copy package.json first
COPY package*.json ./

# Copy schema files BEFORE npm install (para que postinstall funcione)
COPY prisma ./prisma/
ENV DATABASE_URL="postgresql://user:password@host:port/db?schema=public"

# Install dependencies - esto ejecutará prisma generate automáticamente
RUN npm install --omit=dev && npm cache clean --force

# Copy the rest of the application code
COPY . .

# Create a non-root user to run the application (Google Cloud Run best practice)
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /usr/src/app
USER appuser

# Expose the port that Cloud Run expects (8080 by default)
EXPOSE 8080

# Set environment variables for production and Cloud Run
ENV NODE_ENV=production
ENV PORT=8080

# Health check for container
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Command to run the application
CMD [ "node", "index.js" ]

