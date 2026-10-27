"""Vercel serverless entrypoint — exposes the Flask WSGI app as `app`."""
import os
import sys

# Make the project root importable (this file lives in api/).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from signalsift.app import create_app  # noqa: E402

app = create_app()
