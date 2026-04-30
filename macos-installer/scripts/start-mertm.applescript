-- MERT-M Launcher
-- LaunchAgent at login already starts Docker + backend + frontend.
-- This .app just opens Chrome in app-mode.

on run
	set frontendURL to "http://localhost:5174"
	set chromeProfile to (POSIX path of (path to home folder)) & ".mertm-chrome-profile"

	-- Wait briefly if backend not yet ready (LaunchAgent may still be warming up)
	set ready to false
	repeat with i from 1 to 30
		try
			do shell script "/usr/bin/curl -s -o /dev/null --max-time 1 " & frontendURL
			set ready to true
			exit repeat
		on error
			delay 1
		end try
	end repeat

	if not ready then
		-- Try to start manually
		try
			do shell script "/bin/bash -lc 'cd /Applications/MERT-M && bash scripts/start-mertm.sh' > /tmp/mertm-launcher.log 2>&1 &"
			delay 8
		end try
	end if

	-- Open Chrome --app (frameless window, looks native)
	do shell script "/usr/bin/open -na 'Google Chrome' --args --app=" & quoted form of frontendURL & " --user-data-dir=" & quoted form of chromeProfile
end run
