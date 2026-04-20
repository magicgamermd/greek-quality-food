#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/magic/greek-foods-platform/warehouse-frontend
exec /opt/homebrew/bin/npx vite --port 3010 --host 0.0.0.0
