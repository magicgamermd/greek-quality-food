-- MERT-M Update
on run
	tell application "Terminal"
		activate
		do script "cd /Applications/MERT-M && \\
echo '=== MERT-M Update ===' && \\
git pull --rebase && \\
bash scripts/start-greekquality.sh --stop 2>/dev/null; \\
( cd warehouse-backend && npm install --silent ); \\
( cd warehouse-frontend && npm install --silent ); \\
( cd warehouse-backend && npm run migrate ); \\
bash scripts/start-greekquality.sh && \\
sleep 5 && \\
open -na 'Google Chrome' --args --app=http://localhost:5174 --user-data-dir=$HOME/.mertm-chrome-profile && \\
echo '✓ Готово!'"
	end tell
end run
