from __future__ import annotations

import json
import os
from pathlib import Path
import pytest

from dex_core import (
    TrustStore,
    TrustStoreError,
    ActionTracker,
    SpamTracker,
    Cooldowns,
    Response,
    BotAddDecision,
    decide_response,
    decide_bot_add,
    RoleInfo,
    plan_role_removal,
    remove_roles_error_means_actor_gone,
    group_by_channel,
    chunked,
    UNKNOWN_MEMBER_CODE,
)


class DummyAccount:
    def __init__(self, id: int, bot: bool = False):
        self.id = id
        self.bot = bot


# ============================================================================
# 1. TEST TRUST STORE (Schema, Rollback & Legacy State Protection)
# ============================================================================

def test_trust_store_new_installation(tmp_path: Path):
    path = tmp_path / "trust.json"
    store = TrustStore(path)
    assert not store.initialized
    assert store.safe
    assert store.ready is False
    assert store.guild(123) == {"users": [], "bots": []}


def test_trust_store_valid_persistence_and_filtering(tmp_path: Path):
    path = tmp_path / "trust.json"
    store = TrustStore(path)
    store.init_empty()
    assert store.ready is True

    user1 = DummyAccount(111, bot=False)
    bot1 = DummyAccount(222, bot=True)
    
    assert store.add(123, user1) is True
    assert store.add(123, user1) is False  # Trùng lặp
    assert store.add(123, bot1) is True

    store2 = TrustStore(path)
    assert store2.ready is True
    assert store2.is_trusted(user1, 123) is True
    assert store2.is_trusted(bot1, 123) is True
    assert store2.is_trusted(DummyAccount(999), 123) is False


def test_trust_store_corrupt_file_handling(tmp_path: Path):
    path = tmp_path / "trust.json"
    path.write_text("{ invalid json ...", encoding="utf-8")

    store = TrustStore(path)
    assert store.safe is False
    assert store.ready is False
    assert "Không đọc được trust file" in store.reason
    
    corrupt_files = list(tmp_path.glob("*.corrupt"))
    assert len(corrupt_files) == 1


def test_trust_store_rejects_unsupported_schema(tmp_path: Path):
    """Kiểm tra TrustStore phải từ chối các schema_version lạ/không tương thích."""
    path = tmp_path / "trust.json"
    path.write_text(
        json.dumps({
            "schema_version": 999,
            "guilds": {
                "123": {"users": [456], "bots": []}
            },
        }),
        encoding="utf-8",
    )

    store = TrustStore(path)
    assert store.safe is False
    assert store.ready is False


def test_trust_store_legacy_schema_migration(tmp_path: Path):
    path = tmp_path / "trust.json"
    legacy_data = {"users": [123, 456], "bots": [789]}
    path.write_text(json.dumps(legacy_data), encoding="utf-8")

    store = TrustStore(path)
    assert store.safe is False
    assert store.legacy_backup is not None
    assert store.legacy_backup.exists()

    imported_users, imported_bots = store.import_legacy_for_guild(9999)
    assert imported_users == 2
    assert imported_bots == 1
    assert store.safe is True
    assert store.ready is True
    assert store.is_trusted(DummyAccount(123), 9999) is True


def test_trust_store_write_failure_rollback(tmp_path: Path, monkeypatch):
    path = tmp_path / "trust.json"
    store = TrustStore(path)
    store.init_empty()

    user = DummyAccount(555)
    
    def mock_replace(src, dst):
        raise OSError("Disk full / permission denied")

    monkeypatch.setattr(os, "replace", mock_replace)

    with pytest.raises(TrustStoreError):
        store.add(123, user)

    assert user.id not in store.guild(123)["users"]


def test_trust_store_legacy_import_write_failure_preserves_state(tmp_path: Path, monkeypatch):
    """Kiểm tra khi import legacy mà ghi đĩa thất bại, nội dung bản sao và trạng thái an toàn phải được giữ nguyên."""
    path = tmp_path / "trust.json"
    legacy_data = {"users": [123, 456], "bots": [789]}
    path.write_text(json.dumps(legacy_data), encoding="utf-8")

    store = TrustStore(path)
    assert store.safe is False
    assert store.legacy_backup is not None
    backup_content_before = store.legacy_backup.read_text(encoding="utf-8")

    def mock_replace(src, dst):
        raise OSError("Disk write failed during import")

    monkeypatch.setattr(os, "replace", mock_replace)

    with pytest.raises(TrustStoreError):
        store.import_legacy_for_guild(9999)

    assert store.safe is False
    assert store.legacy_backup.exists()
    assert store.legacy_backup.read_text(encoding="utf-8") == backup_content_before


# ============================================================================
# 2. TEST ACTION TRACKER (Single, Total Threshold & Biên thời gian)
# ============================================================================

def test_action_tracker_single_and_total():
    thresholds = {"ban": 3, "kick": 2}
    tracker = ActionTracker(
        window=10.0,
        thresholds=thresholds,
        total_actions={"ban", "kick"},
        total_threshold=4,
    )

    now = 100.0
    guild_id, actor_id = 1, 999

    trg1 = tracker.record(guild_id, actor_id, "ban", now)
    assert not trg1.fired
    assert trg1.single_count == 1

    tracker.record(guild_id, actor_id, "ban", now + 1)
    trg3 = tracker.record(guild_id, actor_id, "ban", now + 2)
    assert trg3.fired is True
    assert "ban: 3 lần" in trg3.reasons[0]


def test_action_tracker_total_threshold():
    """Kiểm tra hành vi gộp nhiều hành động khác nhau dưới ngưỡng đơn nhưng chạm ngưỡng tổng."""
    tracker = ActionTracker(
        window=10.0,
        thresholds={"ban": 10, "kick": 10},
        total_actions={"ban", "kick"},
        total_threshold=4,
    )

    now = 100.0
    for i in range(3):
        result = tracker.record(1, 999, "ban", now + i)
        assert result.fired is False

    result = tracker.record(1, 999, "kick", now + 3)
    assert result.fired is True
    assert any("Tổng hành động nguy hiểm" in r for r in result.reasons)


def test_action_tracker_time_boundary():
    tracker = ActionTracker(window=5.0, thresholds={"spam_action": 2})
    guild, actor = 1, 100
    now = 1000.0

    tracker.record(guild, actor, "spam_action", now)
    trg = tracker.record(guild, actor, "spam_action", now + 4.9)
    assert trg.fired is True

    tracker.record(guild, actor, "spam_action", now + 10.0)
    trg_boundary = tracker.record(guild, actor, "spam_action", now + 14.5)
    assert trg_boundary.single_count == 2
    assert trg_boundary.fired is False


def test_action_tracker_trusted_multiplier():
    tracker = ActionTracker(
        window=10.0,
        thresholds={"purge": 2},
        trusted_multiplier=3,
    )
    guild_id, actor_id = 1, 888
    now = 300.0

    assert not tracker.record(guild_id, actor_id, "purge", now, trusted=False).fired
    assert tracker.record(guild_id, actor_id, "purge", now + 1, trusted=False).fired is True

    for i in range(5):
        trg = tracker.record(guild_id, actor_id + 1, "purge", now + i, trusted=True)
        assert not trg.fired
    
    trg_final = tracker.record(guild_id, actor_id + 1, "purge", now + 6, trusted=True)
    assert trg_final.fired is True


# ============================================================================
# 3. TEST SPAM TRACKER & CHUNKING (Cửa sổ thời gian & Trùng lặp)
# ============================================================================

def test_spam_tracker_window():
    spam = SpamTracker(max_messages=2, window=5.0)
    now = 1000.0

    assert spam.record("user1", now, "msg1", channel_id=50) is False
    assert spam.record("user1", now + 1, "msg2", channel_id=50) is False
    assert spam.record("user1", now + 2, "msg3", channel_id=50) is True

    items = spam.take("user1")
    assert len(items) == 3
    assert spam.take("user1") == []


def test_spam_tracker_time_window_expiry():
    """Kiểm tra tin nhắn cũ tự động hết hạn ngoài cửa sổ, tránh phạt nhầm người chat bình thường."""
    spam = SpamTracker(max_messages=2, window=5.0)
    now = 1000.0

    assert spam.record("user1", now, "msg1", channel_id=50) is False
    assert spam.record("user1", now + 1, "msg2", channel_id=50) is False

    # Sau 6 giây (vượt quá window 5.0), 2 tin nhắn cũ đã trôi qua.
    assert spam.record("user1", now + 6.0, "msg3", channel_id=50) is False


def test_group_by_channel_and_chunked():
    shared = object()
    other = object()

    entries = [
        (10, shared),
        (10, other),
        (20, object()),
        (10, shared),
    ]

    grouped = group_by_channel(entries)
    
    assert len(grouped[10]) == 2
    assert len(grouped[20]) == 1
    assert grouped[10][0] is shared
    assert grouped[10][1] is other

    assert chunked([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    assert chunked([], 2) == []


# ============================================================================
# 4. TEST COOLDOWNS & POLICY DECISIONS
# ============================================================================

def test_cooldowns_logic():
    cd = Cooldowns()
    now = 500.0

    assert cd.active("key1", now) is False
    assert cd.try_acquire("key1", now, seconds=10) is True
    assert cd.active("key1", now + 5) is True
    assert cd.try_acquire("key1", now + 5, seconds=10) is False

    assert cd.active("key1", now + 10) is False
    assert cd.try_acquire("key1", now + 10, seconds=10) is True

    cd.block("key2", now, seconds=0)
    assert cd.active("key2", now) is False


def test_decide_response_matrix():
    assert decide_response(actor_is_owner=False, actor_trusted=False, trust_ready=False, defense_enabled=True, alert_only_action=False) == Response.ALERT_LOCKED
    assert decide_response(actor_is_owner=True, actor_trusted=False, trust_ready=False, defense_enabled=True, alert_only_action=False) == Response.ALERT_OWNER
    
    assert decide_response(actor_is_owner=True, actor_trusted=False, trust_ready=True, defense_enabled=True, alert_only_action=False) == Response.ALERT_OWNER
    assert decide_response(actor_is_owner=False, actor_trusted=True, trust_ready=True, defense_enabled=True, alert_only_action=False) == Response.ALERT_TRUSTED
    assert decide_response(actor_is_owner=False, actor_trusted=False, trust_ready=True, defense_enabled=False, alert_only_action=False) == Response.ALERT_ONLY
    assert decide_response(actor_is_owner=False, actor_trusted=False, trust_ready=True, defense_enabled=True, alert_only_action=True) == Response.ALERT_ONLY
    assert decide_response(actor_is_owner=False, actor_trusted=False, trust_ready=True, defense_enabled=True, alert_only_action=False) == Response.DEFEND


def test_decide_bot_add():
    assert decide_bot_add(actor_is_owner=False, actor_trusted=False, target_trusted=True, trust_ready=True, defense_enabled=True, kick_enabled=True) == BotAddDecision.TRUSTED_BOT
    assert decide_bot_add(actor_is_owner=True, actor_trusted=False, target_trusted=False, trust_ready=True, defense_enabled=True, kick_enabled=True) == BotAddDecision.ALERT_ONLY
    assert decide_bot_add(actor_is_owner=False, actor_trusted=False, target_trusted=False, trust_ready=False, defense_enabled=True, kick_enabled=True) == BotAddDecision.ALERT_LOCKED
    assert decide_bot_add(actor_is_owner=False, actor_trusted=False, target_trusted=False, trust_ready=True, defense_enabled=True, kick_enabled=True) == BotAddDecision.KICK


# ============================================================================
# 5. TEST ROLE PLANNING & UTILS
# ============================================================================

def test_role_planning():
    roles = [
        RoleInfo(id=1, name="Admin", position=10, managed=False, dangerous=True),
        RoleInfo(id=2, name="Default Dangerous Role", position=1, managed=False, dangerous=True, default=True),
        RoleInfo(id=3, name="Bot Integration", position=15, managed=True, dangerous=True),
        RoleInfo(id=4, name="High Role", position=50, managed=False, dangerous=True),
        RoleInfo(id=5, name="Normal Safe", position=5, managed=False, dangerous=False),
    ]
    
    bot_top_position = 20
    plan = plan_role_removal(roles, bot_top_position)

    assert len(plan.removable) == 1
    assert plan.removable[0].name == "Admin"
    assert not any(r.id == 2 for r in plan.removable)
    assert len(plan.blocked_managed) == 1
    assert plan.blocked_managed[0].name == "Bot Integration"
    assert len(plan.blocked_hierarchy) == 1
    assert plan.blocked_hierarchy[0].name == "High Role"

    assert remove_roles_error_means_actor_gone(UNKNOWN_MEMBER_CODE) is True