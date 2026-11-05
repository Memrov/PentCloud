#!/usr/bin/env python3
"""Compatibility entrypoint for the managed Wrangler attempt probe runner."""
import os
import pathlib

runner = pathlib.Path(__file__).with_suffix('.mjs')
os.execvp('node', ['node', str(runner)])
