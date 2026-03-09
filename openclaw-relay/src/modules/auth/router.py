from fastapi import APIRouter, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from .service import AuthService
from ...core.database import get_db
from ...core.security import decode_token
from ...schemas.auth import RegisterRequest, LoginRequest, TokenResponse

router = APIRouter()
auth_service = AuthService()
bearer_scheme = HTTPBearer()


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(request: RegisterRequest, db=Depends(get_db)):
    async with db as session:
        return await auth_service.register(request, session)


@router.post("/login", response_model=TokenResponse)
async def login(request: LoginRequest, db=Depends(get_db)):
    async with db as session:
        return await auth_service.login(request, session)


@router.get("/me")
async def me(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db=Depends(get_db),
):
    payload = decode_token(credentials.credentials)
    user_id = payload.get("sub")
    async with db as session:
        return await auth_service.get_current_user(user_id, session)
