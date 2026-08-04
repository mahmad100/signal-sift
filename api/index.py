"""Vercel serverless entrypoint — exposes the Flask WSGI app as `app`."""
import os
import sys

# Make the project root importable (this file lives in api/).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import jsonify, request  # noqa: E402

from signalsift.app import create_app  # noqa: E402

app = create_app()


# --- TEMPORARY diagnostic (2026-08-04) -------------------------------------
# The live site 404s every path with Werkzeug's page while `/` and
# `/company/<t>` return 200 locally, so Flask is not receiving the real
# request path. This catch-all reports what the function actually sees, so the
# routing fix can be made from evidence instead of guesswork. It only ever
# matches paths no real route claims, and it is Vercel-only (run.py imports
# signalsift.app directly). DELETE once routing is confirmed fixed.
@app.route("/__probe", defaults={"p": ""})
@app.route("/<path:p>")
def _probe(p):
    env = request.environ
    return jsonify(
        matched_catchall=p,
        path_info=env.get("PATH_INFO"),
        script_name=env.get("SCRIPT_NAME"),
        raw_uri=env.get("RAW_URI") or env.get("REQUEST_URI"),
        query_string=env.get("QUERY_STRING"),
        full_url=request.url,
        known_routes=sorted(str(r) for r in app.url_map.iter_rules()),
        x_headers={k: v for k, v in request.headers.items()
                   if k.lower().startswith("x-")},
    )
