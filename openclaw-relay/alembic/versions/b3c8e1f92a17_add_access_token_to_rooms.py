"""add access_token to rooms

Revision ID: b3c8e1f92a17
Revises: 9b5237c7cb43
Create Date: 2026-03-09 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3c8e1f92a17'
down_revision: Union[str, Sequence[str], None] = '9b5237c7cb43'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add access_token column to rooms table.

    access_token is a server-generated random token (secrets.token_urlsafe(16))
    used as the room's "password" for all subsequent API calls. It is stored
    in plain text to allow O(1) indexed lookup without bcrypt overhead.
    Existing rows get a placeholder value; the application layer regenerates
    them on next access if needed.
    """
    op.add_column(
        'rooms',
        sa.Column('access_token', sa.String(length=64), nullable=True)
    )

    # Back-fill existing rows with a unique placeholder so NOT NULL can be
    # enforced after the migration. Real tokens are set on room creation.
    op.execute(
        "UPDATE rooms SET access_token = gen_random_uuid()::text WHERE access_token IS NULL"
    )

    op.alter_column('rooms', 'access_token', nullable=False)

    op.create_index(
        'ix_rooms_access_token',
        'rooms',
        ['access_token'],
        unique=True,
    )


def downgrade() -> None:
    """Remove access_token column from rooms table."""
    op.drop_index('ix_rooms_access_token', table_name='rooms')
    op.drop_column('rooms', 'access_token')
