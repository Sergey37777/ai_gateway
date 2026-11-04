"""Точка входа для uvicorn (`ai_gateway.main:app`); строго один воркер."""

from ai_gateway.app import create_app

app = create_app()
