#!/bin/bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd /Users/magic/Projects/greek-quality-food/warehouse-frontend
exec /opt/homebrew/bin/npx vite --port 5175 --host 0.0.0.0
