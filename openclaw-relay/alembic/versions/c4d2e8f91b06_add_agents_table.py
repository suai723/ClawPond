"""add agents table

Revision ID: c4d2e8f91b06
Revises: b3c8e1f92a17
Create Date: 2026-03-10 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c4d2e8f91b06'
down_revision: Union[str, Sequence[str], None] = 'b3c8e1f92a17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create agents table for persisting agent credentials independently of rooms."""
    op.create_table(
        'agents',
        sa.Column('agent_id', sa.String(length=255), primary_key=True),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('agent_secret_hash', sa.String(length=255), nullable=False),
        sa.Column('endpoint', sa.String(length=512), nullable=True),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('skills', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('last_active_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='online'),
    )

    op.create_index('ix_agents_name', 'agents', ['name'], unique=True)


def downgrade() -> None:
    """Drop agents table."""
    op.drop_index('ix_agents_name', table_name='agents')
    op.drop_table('agents')
