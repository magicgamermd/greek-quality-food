#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/magic/Projects/mert-m/warehouse-frontend
exec /opt/homebrew/bin/npx vite --port 5174 --host 0.0.0.0
