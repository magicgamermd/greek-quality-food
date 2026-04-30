-- MERT-M Stop
on run
	display notification "Спирам MERT-M..." with title "MERT-M"
	try
		do shell script "/bin/bash /Applications/MERT-M/scripts/start-mertm.sh --stop"
	end try
	display notification "MERT-M е спрян" with title "MERT-M"
end run
