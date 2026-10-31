import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, MessageSquarePlus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { ApiRequestError } from '../api/errors';
import { useServerEvents } from '../api/sse';
import { MAX_HEADCOUNT, MEAL_LABEL, MEAL_OPTIONS, type AppSettings, type MealType } from '../api/types';
import { IdentityPickerSheet } from '../components/IdentityPickerSheet';
import { PageHeader } from '../components/PageHeader';
import { Button, ChoiceChip, Segmented, Stepper, cn } from '../components/ui/base';
import { EmptyState, Sheet } from '../components/ui/feedback';
import { toast } from '../components/ui/toast';
import { useCurrentMember, useMembers, useSettings } from '../hooks/useCurrentMember';
import { useIdentity } from '../store/identity';
import { useAsync } from '../hooks/useAsync';
import { useNow } from '../hooks/useNow';
import {
  DAY_OFFSETS,
  cutoffCountdown,
  cutoffFor,
  dayLabelForDate,
  dayOffsetLabel,
  formatDateCN,
  todayISO,
} from '../lib/format';
import {
  cartGroupKey,
  cartGroups,
  groupFingerprint,
  lineKey,
  mealDateFromOffset,
  reusableSubmitToken,
  targetOffset,
  useCart,
  type CartGroup,
  type CartGroupKey,
} from '../store/cart';
import { submitGroups } from '../lib/submitGroups';

/**
 * 提交幂等键：http 内网访问时 crypto.randomUUID 可能不存在（需要安全上下文），
 * 兜一个随机串即可——它只需要「同一次提交里稳定、不同次提交不撞」。
 */
function newSubmitToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function CartPage() {
  const navigate = useNavigate();
  const current = useCurrentMember();
  const members = useMembers();
  const selectMember = useIdentity((state) => state.select);
  const settings = useSettings();
  const lines = useCart((state) => state.lines);
  const headcount = useCart((state) => state.headcount);
  const orderNote = useCart((state) => state.orderNote);
  const setHeadcount = useCart((state) => state.setHeadcount);
  const setOrderNote = useCart((state) => state.setOrderNote);
  const setServings = useCart((state) => state.setServings);
  const setLineNote = useCart((state) => state.setLineNote);
  const remove = useCart((state) => state.remove);
  const moveGroup = useCart((state) => state.moveGroup);
  const clear = useCart((state) => state.clear);

  // 备注弹层按「日+餐+菜」定位到具体某一行
  const [noteOpenFor, setNoteOpenFor] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lateConfirm, setLateConfirm] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // 成功页要在 clear() 之后还能显示刚点了哪几单，先快照下来
  const [submittedGroups, setSubmittedGroups] = useState<CartGroupKey[]>([]);
  // 整组挪到别的天/餐：正在挪的组 + 弹层里的草稿
  const [moving, setMoving] = useState<CartGroup | null>(null);
  const [moveDay, setMoveDay] = useState(0);
  const [moveMeal, setMoveMeal] = useState<MealType>('dinner');
  // 一张单（一天一餐）一个幂等 token：手抖双击 / 截单确认后重提 / 网络重试
  // 都只会得到同一张订单（服务端见 orderService.createOrder 的幂等分支）。
  // token 跟着购物车持久化（见 cart store 的 submitTokens）：服务端已建单但响应丢失时，
  // 刷新/重开页面再提交也不会变成第二张单。
  // 成功的组立即释放 token 并退出购物车（见 submitGroups）——否则用户改完
  // 已成功的组再提交，服务端会按旧 token 返回原单，改动静默丢失。
  const submittedRef = useRef<CartGroupKey[]>([]);
  // 按钮 disabled 要等 React 重渲染才生效；极快的双击可能在渲染前进入两次提交。
  // 用同步 ref 兜住，避免两个并发请求各拿一个新 token 建两张单。
  const inFlightRef = useRef(false);

  // 购物车里的菜可能在别处被下架或彻底删除。进来先对一次全量菜单（含隐藏菜），
  // 只摘掉「真下架 / 真删除」的行：歇菜、季节窗只是默认菜单不展示，
  // 提交端只校验 active，这些菜其实能正常下单，不能悄悄替用户删掉。
  const menu = useAsync(() => api.dishes.list({ includeInactive: true }), []);
  useEffect(() => {
    const available = menu.data?.dishes;
    if (!available || lines.length === 0) return;
    const byId = new Map(available.map((dish) => [dish.id, dish]));
    const deleted = lines.filter((line) => !byId.has(line.dishId));
    const inactive = lines.filter((line) => byId.get(line.dishId)?.active === false);
    const stale = [...deleted, ...inactive];
    if (stale.length === 0) return;
    stale.forEach((line) => remove(line));
    const names = (list: typeof stale) => `「${list.map((line) => line.name).join('、')}」`;
    const reasons = [
      deleted.length > 0 ? `${names(deleted)}已删除` : '',
      inactive.length > 0 ? `${names(inactive)}已下架` : '',
    ].filter(Boolean);
    toast(`${reasons.join('，')}，已从菜单里去掉`, 'error');
  }, [menu.data, lines, remove]);

  // 停留在购物车页时别端下架 / 删菜也要即时摘掉，而不是等提交才报错
  useServerEvents({
    'dish:updated': menu.reload,
    'dish:deleted': menu.reload,
  });

  const servings = lines.reduce((sum, line) => sum + line.servings, 0);

  // (日期, 餐次) = 一张订单：分组展示、分组提交；组内可整组挪到别的天/餐
  const groups = useMemo(() => cartGroups(lines), [lines]);

  const openMove = (group: CartGroup) => {
    setMoving(group);
    setMoveDay(targetOffset(group.mealDate) ?? 0);
    setMoveMeal(group.mealType);
  };

  const applyMove = () => {
    if (!moving) return;
    const to = { mealDate: mealDateFromOffset(moveDay), mealType: moveMeal };
    moveGroup({ mealDate: moving.mealDate, mealType: moving.mealType }, to);
    setMoving(null);
    toast(
      `已把 ${moving.lines.length} 道菜挪到 ${dayLabelForDate(to.mealDate)}·${MEAL_LABEL[to.mealType]}`,
      'success',
    );
  };

  const submit = async (late = false) => {
    if (!current) {
      // 就地选人，别踢回首页：一车菜都挑好了，跳走等于让人重来
      setPickerOpen(true);
      return;
    }
    if (lines.length === 0) {
      toast('菜单还是空的', 'error');
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    // 按日期升序提交：今天排最前，今天过截单被拦时后面的提前单还没创建。
    // 部分失败重试也安全：成功的组会从购物车摘掉并释放 token，
    // 失败的组沿用原 token（见 submitGroups）
    // 从持久化 store 还原未完成组的 token：刷新/重开页面后仍能命中服务端幂等。
    // 只有内容指纹完全一致才复用；失败后改过菜/份数/人数，就丢弃旧 token 重新提交。
    const savedTokens = useCart.getState().submitTokens;
    const tokens = new Map<string, string>();
    const fingerprints = new Map<string, string>();
    for (const group of groups) {
      const key = cartGroupKey(group);
      const fingerprint = groupFingerprint(group, current.id, headcount, orderNote);
      fingerprints.set(key, fingerprint);
      const reusable = reusableSubmitToken(savedTokens[key], fingerprint);
      if (reusable) tokens.set(key, reusable);
      else if (savedTokens[key]) useCart.getState().releaseSubmitToken(key);
    }
    const groupByKey = new Map(groups.map((group) => [cartGroupKey(group), group]));
    try {
      await submitGroups(
        groups.map((group) => ({
          key: cartGroupKey(group),
          submit: (clientToken) =>
            api.orders.create({
              memberId: current.id,
              mealDate: group.mealDate,
              mealType: group.mealType,
              headcount,
              note: orderNote,
              late,
              clientToken,
              items: group.lines.map((line) => ({ dishId: line.dishId, servings: line.servings, note: line.note })),
            }),
        })),
        tokens,
        newSubmitToken,
        (group) => {
          // 已经下过的菜不该继续留在可编辑的购物车里：改完再提交会被服务端
          // 按旧 token 当重复提交吞掉。摘掉它，失败的组才留下来重试。
          const done = groupByKey.get(group.key);
          if (!done) return;
          if (!submittedRef.current.some((item) => cartGroupKey(item) === group.key)) {
            submittedRef.current.push({ mealDate: done.mealDate, mealType: done.mealType });
          }
          useCart.getState().releaseSubmitToken(group.key);
          done.lines.forEach((line) => remove(line));
        },
        (key, token) => {
          const fingerprint = fingerprints.get(key);
          if (fingerprint) useCart.getState().setSubmitToken(key, token, fingerprint);
        },
      );
      setSubmittedGroups([...submittedRef.current]);
      clear();
      setLateConfirm(null);
      setSuccess(true);
      // 跳到看板的对应日期，提前点的单也要能立刻看到
      setTimeout(
        () => navigate(`/chef?date=${submittedRef.current[0]?.mealDate ?? groups[0]?.mealDate ?? todayISO()}`),
        1200,
      );
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'CUTOFF_PASSED') {
        // 不是整轮都失败：可能早餐已下好、午餐才被截单拦住。把已成功的单数说清楚。
        const done = submittedRef.current.length;
        setLateConfirm(done > 0 ? `${done} 张单已经下好；${error.message}` : error.message);
      } else {
        const message = error instanceof Error ? error.message : '提交失败';
        const done = submittedRef.current.length;
        toast(done > 0 ? `${done} 张单已经下好，剩下的没提交成功：${message}` : message, 'error');
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  if (success) {
    const first = submittedGroups[0];
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center gap-3 px-8">
        <CheckCircle2 size={64} className="animate-pop text-fresh" />
        <p className="text-[18px] font-semibold">已经交给大厨啦</p>
        <p className="text-[13px] text-ink-400">
          {submittedGroups.length > 1
            ? `${submittedGroups.length} 张单已分别下单 · 正在跳转到订单看板…`
            : first
              ? `${dayLabelForDate(first.mealDate)}（${formatDateCN(first.mealDate)}）· ${MEAL_LABEL[first.mealType]} · 正在跳转到订单看板…`
              : '正在跳转到订单看板…'}
        </p>
      </div>
    );
  }

  const firstGroup = groups[0];

  return (
    <div className="pb-40">
      <PageHeader
        title="确认菜单"
        subtitle={
          lines.length === 0
            ? '还没选菜'
            : [
                firstGroup
                  ? groups.length > 1
                    ? `${dayLabelForDate(firstGroup.mealDate)} 等 ${groups.length} 张单`
                    : `${dayLabelForDate(firstGroup.mealDate)}·${MEAL_LABEL[firstGroup.mealType]}`
                  : '',
                `${lines.length} 道菜`,
              ]
                .filter(Boolean)
                .join(' · ')
        }
        back
      />

      {lines.length === 0 ? (
        <div className="px-4 pt-4">
          <EmptyState
            emoji="🧺"
            title="购物车是空的"
            description="还没有选菜，先去点菜页挑几道想吃的。"
            action={<Button onClick={() => navigate('/order')}>去点菜</Button>}
          />
        </div>
      ) : (
        <>
          {groups.map((group) => (
            <div key={cartGroupKey(group)} className="mt-4 first:mt-3">
              <div className="mx-4 flex items-baseline gap-2">
                <p className="text-[15px] font-semibold">
                  {dayLabelForDate(group.mealDate)} · {MEAL_LABEL[group.mealType]}
                </p>
                <p className="text-[12px] text-ink-400">
                  {formatDateCN(group.mealDate)} · {group.lines.length} 道菜
                </p>
                <button
                  type="button"
                  onClick={() => openMove(group)}
                  className="press ml-auto shrink-0 text-[12px] font-medium text-brand-500"
                >
                  改天或换餐
                </button>
              </div>
              <GroupCutoffBanner mealDate={group.mealDate} mealType={group.mealType} settings={settings} />

              <section className="mt-2 space-y-2.5 px-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-2.5 lg:space-y-0">
                {group.lines.map((line) => (
                  <div key={lineKey(line)} className="card p-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-11 w-11 items-center justify-center rounded-xl2 bg-cream-200 text-xl">
                        {line.emoji}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-semibold">{line.name}</p>
                        <p className="text-[11px] text-ink-400">{line.category}</p>
                      </div>
                      <Stepper
                        value={line.servings}
                        min={0}
                        max={20}
                        size="sm"
                        onChange={(value) => setServings(line, value)}
                      />
                    </div>

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setNoteOpenFor(lineKey(line))}
                        className="press flex items-center gap-1 rounded-full bg-cream-100 px-2.5 py-1 text-[11px] text-ink-600"
                      >
                        <MessageSquarePlus size={12} />
                        {line.note ? `备注：${line.note}` : '加备注'}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(line)}
                        className="press ml-auto flex items-center gap-1 rounded-full bg-alert/10 px-2.5 py-1 text-[11px] text-alert"
                      >
                        <Trash2 size={12} />
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            </div>
          ))}

          {/* 平板（744~1279）两列。日期与餐次都已按组显示在上面的分组头里，
              这里只剩「整车共用」的两项：人数与备注 */}
          <section className="mt-4 space-y-3 px-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-3 lg:space-y-0">
            <div className="card flex items-center justify-between p-3.5">
              <div>
                <p className="text-[13px] font-semibold">几个人吃</p>
                <p className="text-[11px] text-ink-400">影响营养分析里的人均摄入</p>
              </div>
              <Stepper value={headcount} min={1} max={MAX_HEADCOUNT} onChange={setHeadcount} />
            </div>

            <div className="card p-3.5">
              <p className="mb-2 text-[13px] font-semibold">整单备注</p>
              <textarea
                value={orderNote}
                onChange={(event) => setOrderNote(event.target.value)}
                rows={2}
                placeholder="例如：少盐少油、不要香菜、孩子不吃辣"
                className="w-full resize-none rounded-xl2 border border-cream-400 bg-white px-3 py-2 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
              />
            </div>
          </section>
        </>
      )}

      {/* 购物车页没有左侧图标栏（hideNav）。提交条做成悬浮玻璃卡片，
          与导航胶囊同语言；横屏不必铺满整屏，收窄居中。
          注意别叠 app-bar：它带的 w-full 会与 inset-x-3 过度约束，
          解析出负 margin 把整条卡片顶出屏幕右侧 12px（胶囊看起来整体偏右）。
          要「手机缩进 / 大屏收窄居中」用 mx-auto + max-w 表达即可 */}
      {lines.length > 0 ? (
        <div className="glass-float fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+10px)] z-40 mx-auto max-w-[480px] rounded-xl3 px-4 py-3 lg:max-w-2xl">
          <div className="mb-2 flex items-center justify-between gap-2 text-[12px] text-ink-400">
            <span className="truncate">
              {groups.length > 1 ? `${groups.length} 张单 · ` : ''}
              共 {lines.length} 道菜 · {servings} 份
            </span>
            {current ? (
              <span className="shrink-0">点菜人：{current.name}</span>
            ) : (
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="press shrink-0 font-medium text-alert"
              >
                尚未选择点菜人，点这里选
              </button>
            )}
          </div>
          <Button block size="lg" disabled={submitting} onClick={() => void submit(false)}>
            {submitting
              ? '提交中…'
              : groups.length > 1
                ? `提交给大厨（${groups.length} 张单）`
                : `提交给大厨（${dayLabelForDate(firstGroup?.mealDate ?? todayISO())}·${MEAL_LABEL[firstGroup?.mealType ?? 'dinner']}）`}
          </Button>
        </div>
      ) : null}

      <Sheet open={noteOpenFor !== null} onClose={() => setNoteOpenFor(null)} title="这道菜的备注">
        <div className="pb-6">
          <textarea
            rows={3}
            value={lines.find((line) => lineKey(line) === noteOpenFor)?.note ?? ''}
            onChange={(event) => {
              const line = lines.find((item) => lineKey(item) === noteOpenFor);
              if (line) setLineNote(line, event.target.value);
            }}
            placeholder="例如：不放辣、多放蒜、要软一点"
            className="w-full resize-none rounded-xl2 border border-cream-400 bg-white px-3 py-2 text-[14px] placeholder:text-ink-200 focus:border-brand-400"
          />
          <Button block size="lg" className="mt-3" onClick={() => setNoteOpenFor(null)}>
            保存备注
          </Button>
        </div>
      </Sheet>

      <Sheet open={Boolean(lateConfirm)} onClose={() => setLateConfirm(null)} title="已经过截单时间">
        <div className="pb-6">
          <p className="text-[14px] leading-6 text-ink-600">
            {lateConfirm}。如果大厨还没开始备料，仍然可以提交；否则建议改成下一个餐次。
          </p>
          <div className="mt-4 flex gap-2">
            <Button variant="outline" block onClick={() => setLateConfirm(null)}>
              我再想想
            </Button>
            <Button block onClick={() => void submit(true)}>
              仍然提交
            </Button>
          </div>
        </div>
      </Sheet>

      {/* 整组挪到别的天 / 别的餐：挪过去撞上同名菜会合并份数（与加菜同一套规则） */}
      <Sheet open={Boolean(moving)} onClose={() => setMoving(null)} title="挪到哪一天？">
        {moving ? (
          <div className="space-y-4 pb-6">
            <p className="rounded-xl2 bg-cream-100 px-3 py-2 text-[12px] text-ink-600">
              当前：{dayLabelForDate(moving.mealDate)} · {MEAL_LABEL[moving.mealType]}，
              {moving.lines.length} 道菜一起挪。
            </p>
            <div>
              <p className="mb-2 text-[13px] font-medium text-ink-600">哪天</p>
              <div className="flex gap-1.5">
                {DAY_OFFSETS.map((offset) => (
                  <ChoiceChip
                    key={offset}
                    active={moveDay === offset}
                    className="h-9 flex-1"
                    onClick={() => setMoveDay(offset)}
                  >
                    {dayOffsetLabel(offset)}
                  </ChoiceChip>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[13px] font-medium text-ink-600">哪一餐</p>
              <Segmented value={moveMeal} onChange={setMoveMeal} options={MEAL_OPTIONS} />
            </div>
            <Button
              block
              size="lg"
              disabled={mealDateFromOffset(moveDay) === moving.mealDate && moveMeal === moving.mealType}
              onClick={applyMove}
            >
              挪过去
            </Button>
          </div>
        ) : null}
      </Sheet>

      <IdentityPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        members={members}
        currentId={current?.id ?? null}
        title="这单谁来点"
        description="整车菜会记在这位家人名下，提交前确认一下是谁在点。"
        onSelect={(member) => {
          selectMember(member.id);
          setPickerOpen(false);
          toast(`${member.avatar} 这单记在 ${member.name} 名下`, 'success');
        }}
      />
    </div>
  );
}

/**
 * 每组头下的截单提示条。自带 useNow：30 秒一次的时间跳动只重渲染这一条提示，
 * 不再带着整页购物车行卡片每 30s 全量重渲染（同 OrderPage 的 CutoffCountdown）；
 * 「今天/过去」的判断也按当前时间刷新，页面开久了不会显示过期状态。
 */
function GroupCutoffBanner({
  mealDate,
  mealType,
  settings,
}: {
  mealDate: string;
  mealType: MealType;
  settings: AppSettings | null;
}) {
  const now = useNow();
  const isToday = mealDate === todayISO(now);
  const isPast = mealDate < todayISO(now);
  const groupCutoff = cutoffFor(settings, mealType);
  const countdown = cutoffCountdown(groupCutoff, now);
  return (
    <div
      className={cn(
        'mx-4 mt-2 flex items-center gap-2 rounded-xl2 px-3 py-2 text-[12px]',
        isPast
          ? 'bg-alert/10 text-alert'
          : isToday
            ? countdown.passed
              ? 'bg-alert/10 text-alert'
              : 'bg-warn/10 text-[#8A4B00]'
            : 'bg-cool/10 text-cool',
      )}
    >
      {isPast
        ? '这一天已经过去了，这一组记得删掉或改天。'
        : isToday
          ? countdown.passed
            ? `今天${MEAL_LABEL[mealType]}截单时间 ${groupCutoff} 已过，提交时会再确认一次`
            : `${countdown.text}（${groupCutoff} 截单），大厨要按这个时间备料`
          : `这是提前给${dayLabelForDate(mealDate)}${MEAL_LABEL[mealType]}点的单，不受今天截单时间限制。`}
    </div>
  );
}
