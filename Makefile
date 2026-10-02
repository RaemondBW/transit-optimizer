PY := .venv/bin/python

setup:
	uv venv .venv -p 3.12 && uv pip install --python $(PY) -r requirements.txt

gtfs:
	mkdir -p data/gtfs && curl -sL -o data/gtfs/muni_gtfs.zip https://muni-gtfs.apps.sfmta.com/data/muni_gtfs-current.zip
	cd data/gtfs && unzip -oq muni_gtfs.zip
	cd pipeline && ../$(PY) gtfs.py

signals:        # SFMTA traffic signal inventory (DataSF ybh5-27n2)
	mkdir -p data/signals && curl -s 'https://data.sf.gov/resource/ybh5-27n2.json?$$limit=5000' -o data/signals/traffic_signals.json

avl:            # recent realtime GPS (Cal-ITP public export, June 2026)
	$(PY) pipeline/fetch_calitp.py 2026-06-10

avl-2021:       # older DataSF archive (no route ids); keep separate from recent data
	$(PY) pipeline/fetch_avl.py

match:
	cd pipeline && ../$(PY) match.py

analyze:
	cd pipeline && ../$(PY) analyze.py

# 511 live capture (runs as a LaunchAgent; see README)
capture-status:
	@cat data/raw/live/status.json; echo; tail -3 data/raw/live/collector.log; ls -la data/raw/live/*.csv

capture-stop:
	launchctl bootout gui/$$(id -u)/com.transit-optimizer.muni-capture

live:           # match every captured day, then analyze only those days
	cd pipeline && ../$(PY) match.py $$(ls ../data/raw/live/avl_*.csv) && \
	  ../$(PY) analyze.py $$(ls ../data/raw/live/avl_*.csv | sed -E 's/.*avl_(.*)\.csv/\1/')

all: gtfs signals avl match analyze

serve:
	$(PY) serve.py 8765

.PHONY: signals capture-status capture-stop live setup gtfs avl avl-2021 match analyze all serve
