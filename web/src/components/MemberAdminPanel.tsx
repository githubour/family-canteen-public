import { useState } from 'react';
import { api } from '../api/client';
import type { Member } from '../api/types';
import { MemberPicker } from './MemberPicker';
import { Button, cn } from './ui/base';
import { Sheet } from './ui/feedback';
import { toast } from './ui/toast';
import { useMembers } from '../hooks/useCurrentMember';
import { runAction } from '../lib/runAction';
import { useDestructiveConfirm } from '../hooks/useDestructiveConfirm';
import { useAppStore } from '../store/app';
import { useIdentity } from '../store/identity';

/**
 * 家人管理：添加新成员、移除不再需要的成员（从首页「今天谁来点菜」卡整体迁来）。
 * 这里只管名单、不选身份——点菜页/大厨页没认人时会自动弹选人层，页头药丸可随时换人，
 * 在管理界面点头像不再切换当前身份（避免手滑把订单记到别人头上）。
 */
export function MemberAdminPanel() {
  const members = useMembers();
  const setMembers = useAppStore((state) => state.setMembers);
  const memberId = useIdentity((state) => state.memberId);
  const chefId = useIdentity((state) => state.chefId);
  const clearMember = useIdentity((state) => state.clear);
  const clearChef = useIdentity((state) => state.clearChef);

  const [manageMode, setManageMode] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAvatar, setNewAvatar] = useState('🙂');
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);
  // 移除家人的二次确认层
  const { runDestructive, confirmSheet } = useDestructiveConfirm();

  const createMember = async () => {
    if (!newName.trim()) {
      toast('请填写称呼', 'error');
      return;
    }
    await runAction(async () => {
      const result = await api.members.create({ name: newName.trim(), avatar: newAvatar, role: 'diner' });
      if (result.member) {
        setMembers([...members, result.member]);
        toast(`欢迎 ${result.member.name}`, 'success');
      }
      setCreateOpen(false);
      setNewName('');
    }, '没建成功，请重试');
  };

  const removeMember = async () => {
    if (!pendingRemove) return;
    setRemoving(true);
    try {
      await runAction(
        async () => {
          await runDestructive({
            title: '移除家人',
            warning: `将移除「${pendingRemove.name}」；有历史订单的成员服务端会拒绝，此处仅拦截误删。`,
            run: async () => {
              await api.members.remove(pendingRemove.id);
              setMembers(members.filter((member) => member.id !== pendingRemove.id));
              // 移除的正好是当前身份时，本地点菜人/大厨一并清掉，避免停留在「已消失的人」上
              if (memberId === pendingRemove.id) clearMember();
              if (chefId === pendingRemove.id) clearChef();
              toast(`已移除 ${pendingRemove.name}`, 'success');
              if (members.length <= 1) setManageMode(false);
              setPendingRemove(null);
            },
          });
        },
        '移除失败',
        // 后端对「已有历史订单」的成员会拒绝删除，原因直接转达；失败也要收起确认层
        () => setPendingRemove(null),
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="mt-3 px-4">
      <div className="card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold">家人 · {members.length} 位</p>
            <p className="truncate text-[11px] text-ink-400">加人删人在这里，选谁点菜/掌勺去各页的选人弹层</p>
          </div>
          {members.length > 0 ? (
            <button
              type="button"
              onClick={() => setManageMode((value) => !value)}
              className="press shrink-0 text-[12px] font-medium text-brand-500"
            >
              {manageMode ? '完成' : '管理'}
            </button>
          ) : null}
        </div>
        <MemberPicker
          members={members}
          onCreate={() => setCreateOpen(true)}
          manageMode={manageMode}
          onRemove={(member) => setPendingRemove(member)}
        />
        {manageMode ? (
          <p className="mt-2.5 text-[11px] leading-4 text-ink-400">
            点家人头像右上角的 ✕ 即可移除；已经点过菜的家人不能移除，不然以前的订单就对不上人了。
          </p>
        ) : null}
      </div>

      <Sheet open={createOpen} onClose={() => setCreateOpen(false)} title="添加家庭成员">
        <div className="space-y-4 pb-4">
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-600">称呼</p>
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="例如：外婆、表哥、小满"
              className="h-11 w-full rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] placeholder:text-ink-200 focus:border-brand-400"
            />
          </div>
          <div>
            <p className="mb-2 text-[13px] font-medium text-ink-600">头像</p>
            <div className="flex flex-wrap gap-2">
              {['🙂', '🧑‍🍳', '👨‍🍳', '👩‍🍳', '👩', '👨', '👧', '👦', '👴', '👵', '🐱', '🐶'].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setNewAvatar(emoji)}
                  className={cn(
                    'press flex h-11 w-11 items-center justify-center rounded-full border-2 text-xl',
                    newAvatar === emoji ? 'border-brand-500 bg-brand-50' : 'border-cream-300 bg-white',
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <Button block size="lg" onClick={() => void createMember()}>
            确认添加
          </Button>
        </div>
      </Sheet>

      <Sheet open={Boolean(pendingRemove)} onClose={() => setPendingRemove(null)} title="移除家庭成员">
        {pendingRemove ? (
          <div className="pb-6">
            <div className="flex items-center gap-3 rounded-xl2 bg-cream-100 p-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-2xl">
                {pendingRemove.avatar}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold">{pendingRemove.name}</p>
                <p className="text-[11px] leading-4 text-ink-400">
                  {memberId === pendingRemove.id
                    ? '这正是你当前选中的身份，移除后会一并清掉选择'
                    : '移除后不再出现在选人列表里，可以随时重新添加'}
                </p>
              </div>
            </div>
            <p className="mt-3 rounded-xl2 bg-warn/10 px-3 py-2 text-[11px] leading-5 text-[#8A4B00]">
              已经点过菜的家人不能移除，否则历史订单会找不到人；这种情况建议改名保留，或先删掉他的订单。
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" block onClick={() => setPendingRemove(null)}>
                先不删
              </Button>
              <Button variant="danger" block disabled={removing} onClick={() => void removeMember()}>
                {removing ? '移除中…' : '确认移除'}
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
      {confirmSheet}
    </section>
  );
}
