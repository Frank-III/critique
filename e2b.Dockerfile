# E2B Sandbox Template for Critique
# This creates a minimal environment with Bun and critique installed

FROM e2b/base

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install critique globally
RUN bun add -g critique

# Verify installation
RUN critique --help
