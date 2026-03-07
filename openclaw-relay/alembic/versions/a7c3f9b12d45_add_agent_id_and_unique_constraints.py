"""add agent_id to room_members and unique constraints

Revision ID: a7c3f9b12d45
Revises: 259f1a3a4182
Create Date: 2026-03-07 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7c3f9b12d45'
down_revision: Union[str, Sequence[str], None] = '259f1a3a4182'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.
    
    1. Add agent_id column to room_members (stores the UUID issued by AgentRegistry).
       Nullable so existing human members are unaffected.
    2. Add UNIQUE(room_id, agent_id) constraint – ensures one agent UUID per room.
    3. Add UNIQUE(room_id, username) constraint for agent members only is enforced
       at the application layer; the DB constraint covers all member types to
       prevent duplicate display names within a room.
    """
    # Add agent_id column (nullable – only populated for agent members)
    op.add_column(
        'room_members',
        sa.Column('agent_id', sa.String(length=255), nullable=True)
    )

    # Index for fast agent_id lookups
    op.create_index(
        'ix_room_members_agent_id',
        'room_members',
        ['agent_id'],
        unique=False
    )

    # UNIQUE constraint: one agent UUID per room
    op.create_index(
        'uq_room_members_room_agent_id',
        'room_members',
        ['room_id', 'agent_id'],
        unique=True,
        postgresql_where=sa.text("agent_id IS NOT NULL")
    )

    # UNIQUE constraint: one username per room (prevents same display name in a room)
    op.create_index(
        'uq_room_members_room_username',
        'room_members',
        ['room_id', 'username'],
        unique=True
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('uq_room_members_room_username', table_name='room_members')
    op.drop_index('uq_room_members_room_agent_id', table_name='room_members')
    op.drop_index('ix_room_members_agent_id', table_name='room_members')
    op.drop_column('room_members', 'agent_id')
