"""Web 模块测试夹具."""

import pytest
from fastapi import FastAPI

from web.src.app import create_app


@pytest.fixture(scope="session")
def app() -> FastAPI:
    """提供会话级复用的 FastAPI 应用实例."""
    return create_app()
