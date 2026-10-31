import { useEffect, useMemo, useState } from 'react';
import { Dices } from 'lucide-react';
import { api } from '../api/client';
import { useServerEvents } from '../api/sse';
import { MEAL_LABEL, type AppSettings, type Dish, type MealType } from '../api/types';
import { CartBar } from '../components/CartBar';
import { FridgeStockSheet } from '../components/FridgeStockSheet';
import { IdentityPickerSheet } from '../components/IdentityPickerSheet';
import { MemberPill } from '../components/MemberPill';
import { PageHeader } from '../components/PageHeader';
import { ComboSheet } from '../components/order/ComboSheet';
import { DishDetailSheet } from '../components/order/DishDetailSheet';
import { DishHideConfirmSheet } from '../components/order/DishHideConfirmSheet';
import { DishGrid } from '../components/order/DishGrid';
import { DishRequestSheet } from '../components/order/DishRequestSheet';
import { FridgeStockBanner } from '../components/order/FridgeStockBanner';
import { OrderFilterBar } from '../components/order/OrderFilterBar';
import { cn } from '../components/ui/base';
import { Sheet } from '../components/ui/feedback';
import { toast } from '../components/ui/toast';
import { useAsync } from '../hooks/useAsync';
import { useAskOnce } from '../hooks/useAskOnce';
import { useCurrentMember, useMembers, useSettings } from '../hooks/useCurrentMember';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useDishFeedback } from '../hooks/useDishFeedback';
import { useDishStockInfo } from '../hooks/useDishStockInfo';
import { useNow } from '../hooks/useNow';
import { useIdentity } from '../store/identity';
import { DAY_OFFSETS, cutoffCountdown, cutoffFor, dayLabelForDate, dayOffsetLabel, formatDateCN, formatWeekday, guessMealType, todayISO } from '../lib/format';
import { runAction } from '../lib/runAction';
import { mealDateFromOffset, resolveTarget, targetOffset, useCart, type CartGroupKey } from '../store/cart';

export function OrderPage() {
  const settings = useSettings();
  const current = useCurrentMember();
  const members = useMembers();
  const selectMember = useIdentity((state) => state.select);
  const lines = useCart((state) => state.lines);
  const mealType = useCart((state) => state.mealType);
  const setMealType = useCart((state) => state.setMealType);
  const targetDate = useCart((state) => state.targetDate);
  const setTargetDate = useCart((state) => state.setTargetDate);
  const headcount = useCart((state) => state.headcount);
  const add = useCart((state) => state.add);

  const [category, setCategory] = useState<string>('全部');
  const [keyword, setKeyword] = useState('');
  // 只看「核心（必有）食材齐、现在能做」的菜：可选配料缺了不算事
  const [onlyCanMake, setOnlyCanMake] = useState(false);
  const [detail, setDetail] = useState<Dish | null>(null);
  // 详情弹窗里「本次加几份」：先选后加，不用先把菜放进购物车再调
  const [detailServings, setDetailServings] = useState(1);
  // 详情弹层里「哪天吃」：默认跟随点菜目标，单道菜可以单独改天
  const [detailDay, setDetailDay] = useState(0);
  const [combo, setCombo] = useState<Dish[] | null>(null);
  const [comboLoading, setComboLoading] = useState(false);
  // 点菜目标弹层：选「给哪天点」，之后加入的菜都落到那天
  const [targetOpen, setTargetOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestName, setRequestName] = useState('');
  const [requestNote, setRequestNote] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [pendingHide, setPendingHide] = useState<Dish | null>(null);
  const [hiding, setHiding] = useState(false);
  // 选人弹层：身份按会话记忆，进页没认过人时自动弹一次（可关掉先逛菜单）
  const [pickerOpen, setPickerOpen] = useState(false);
  // 库存登记弹层：点菜页就地登记/编辑冰箱库存，不用绕去大厨页
  const [fridgeOpen, setFridgeOpen] = useState(false);

  // 输入停下来 300ms 才带着关键词去搜，避免每敲一个字发一次请求
  const query = useDebouncedValue(keyword, 300).trim();

  useEffect(() => {
    // 目标日期是「上次点菜时的意图」：隔天再进来先回落到今天，别把菜点到过去
    if (useCart.getState().targetDate < todayISO()) setTargetDate(todayISO());
    // 只在购物车为空时按时间猜默认餐次；车里有菜说明用户可能特意选过餐次，
    // 每次进页都强制重置的话，早上进来会把昨晚选好的「晚餐」悄悄改回「午餐」。
    if (useCart.getState().lines.length === 0) setMealType(guessMealType());
  }, [setMealType, setTargetDate]);

  // 成员加载完还没认人：弹一次「今天谁来点菜」。共用设备上每人每次打开
  // 都得明示自己是谁，订单才不会记到上一个人头上
  useAskOnce(members.length > 0 && !current, () => setPickerOpen(true));

  const dishes = useAsync(() => api.dishes.list({ category, q: query }), [category, query]);
  // 冰箱清空计划：登记了家里现成有的食材，据此把带库存的菜排前面
  const fridge = useAsync(() => api.fridge.list(), []);

  /** 拉某道菜的反馈，写进缓存（只动这一道，不整页刷新） */
  const { feedbacksByDish, loadFeedback } = useDishFeedback();

  // 别处下架/恢复/删除菜品、反馈增删、库存登记变化时同步刷新
  useServerEvents({
    'dish:updated': dishes.reload,
    // 后台把废菜彻底删掉后，点菜页的菜单也要跟着收掉那道菜
    'dish:deleted': dishes.reload,
    'dish-feedback:updated': (payload) => {
      const dishId = Number(payload.dishId);
      if (dishId) void loadFeedback(dishId);
    },
    'fridge:updated': fridge.reload,
  });

  const servingsOf = useMemo(() => {
    // 一行菜 = 日期 + 菜，同一道菜可能在今天和明天各有一行：角标按菜跨天合计
    const map = new Map<number, number>();
    for (const line of lines) map.set(line.dishId, (map.get(line.dishId) ?? 0) + line.servings);
    return map;
  }, [lines]);

  // 库存关系、排序与搜索命中全是纯派生：收进 hook，页面只把结果转给卡片
  const { stockInfo, hasStock, canMakeCount, listedDishes, ingredientHits } = useDishStockInfo(
    dishes.data,
    fridge.data,
    onlyCanMake,
    mealType,
  );

  // 详情弹层的配料标绿用：库存里有的食材 id 集合
  const stockIds = useMemo(
    () => new Set((fridge.data?.items ?? []).map((item) => item.ingredient_id)),
    [fridge.data],
  );

  // 页头倒计时收在 <CutoffCountdown /> 里（见文件底部）：useNow 的 30s 跳动
  // 只重渲染那一小片，不再带着整页菜品网格每 30s 全量重渲染。

  // 换一道菜打开详情时，份数回到 1 份、日期跟回点菜目标（单道菜可以再单独改），
  // 避免上一次的选择悄悄带过来。只在换菜时重置——弹层开着时目标也改不了。
  useEffect(() => {
    setDetailServings(1);
    setDetailDay(targetOffset(useCart.getState().targetDate) ?? 0);
  }, [detail?.id]);

  // 详情弹层开在哪道菜，就拉哪道菜的反馈
  useEffect(() => {
    if (detail) void loadFeedback(detail.id);
  }, [detail, loadFeedback]);

  const addDish = (dish: Dish, servings = 1, override?: Partial<CartGroupKey>) => {
    // 没认人先别往购物车里放：等到了结算才发现没选人，一车菜就白挑了
    if (members.length === 0) {
      toast('先去首页添加家庭成员', 'error');
      return;
    }
    if (!current) {
      setPickerOpen(true);
      toast('先选一下谁在点菜', 'info');
      return;
    }
    add(dish, servings, override);
    // 落点与 store 用同一套解析：toast 说的就是菜真正去的地方
    const at = resolveTarget(override, { mealDate: targetDate, mealType });
    toast(
      `已加入「${dish.name}」· ${dayLabelForDate(at.mealDate)}·${MEAL_LABEL[at.mealType]}${servings > 1 ? ` · ${servings} 份` : ''}`,
      'success',
    );
  };

  const rollRandom = async () => {
    await runAction(async () => {
      const result = await api.dishes.random(1, category, mealType);
      const dish = result.dishes[0];
      if (!dish) {
        toast('这个分类下暂时没有菜', 'error');
        return;
      }
      setDetail(dish);
    }, '随机失败，请重试');
  };

  const buildCombo = async () => {
    setComboLoading(true);
    try {
      await runAction(async () => {
        const result = await api.dishes.recommend(
          headcount,
          lines.map((line) => line.dishId),
          mealType,
        );
        setCombo(result.dishes);
      }, '配菜失败，请重试');
    } finally {
      // 必须放 finally：请求失败时不能把按钮永远卡在「配菜中」
      setComboLoading(false);
    }
  };

  const addCombo = () => {
    for (const dish of combo ?? []) add(dish, 1);
    toast(`已加入 ${combo?.length ?? 0} 道菜 · ${dayLabelForDate(targetDate)}·${MEAL_LABEL[mealType]}`, 'success');
    setCombo(null);
  };

  const hideDish = async () => {
    if (!pendingHide) return;
    setHiding(true);
    try {
      await runAction(async () => {
        await api.dishes.setActive(pendingHide.id, false);
        toast(`已把「${pendingHide.name}」从菜单移除`, 'success');
        setPendingHide(null);
        setDetail(null);
        dishes.reload();
      }, '移除失败');
    } finally {
      setHiding(false);
    }
  };

  const openRequest = (name = '') => {
    setRequestName(name);
    setRequestNote('');
    setRequestOpen(true);
  };

  const submitRequest = async () => {
    const name = requestName.trim();
    if (!name) {
      toast('请填写想吃的菜名', 'error');
      return;
    }
    setRequesting(true);
    try {
      await runAction(async () => {
        await api.dishRequests.create({ name, note: requestNote.trim() || undefined, memberId: current?.id });
        toast(`已提交「${name}」，等统一加入菜单`, 'success');
        setRequestOpen(false);
        setRequestName('');
        setRequestNote('');
      }, '提交失败');
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="pb-[120px] lg:pb-24">
      <PageHeader
        title="点菜"
        subtitle={
          <>
            {/* 点菜目标常驻页头：之后加的菜都落到这一天这一餐，点旁边就能改 */}
            {dayLabelForDate(targetDate)}·{MEAL_LABEL[mealType]}
            {' · '}
            {headcount}人
            {' · '}
            <CutoffCountdown targetDate={targetDate} settings={settings} mealType={mealType} />
          </>
        }
        action={
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 点菜人常驻页头：共用设备上「现在记在谁名下」必须一眼可见，选中后常驻个人主题色 */}
            {members.length > 0 ? (
              <MemberPill member={current} placeholder="谁在点菜？" onClick={() => setPickerOpen(true)} />
            ) : null}
            <button
              type="button"
              onClick={() => void rollRandom()}
              className="press flex h-9 items-center gap-1 rounded-full bg-white px-3 text-[12px] font-medium text-brand-600 shadow-card"
            >
              <Dices size={14} />
              随机
            </button>
          </div>
        }
      />

      <OrderFilterBar
        mealType={mealType}
        onSelectMealType={setMealType}
        targetDate={targetDate}
        onOpenTarget={() => setTargetOpen(true)}
        keyword={keyword}
        onKeywordChange={setKeyword}
        category={category}
        onSelectCategory={setCategory}
        comboLoading={comboLoading}
        onBuildCombo={() => void buildCombo()}
      />

      <div className="px-4 pt-1">
        <FridgeStockBanner
          ready={fridge.data !== null}
          hasStock={hasStock}
          stockCount={(fridge.data?.items ?? []).length}
          canMakeCount={canMakeCount}
          onlyFree={onlyCanMake}
          onToggleOnlyFree={() => setOnlyCanMake((value) => !value)}
          onRegister={() => setFridgeOpen(true)}
        />

        <DishGrid
          // 只在「还没有任何数据」时铺骨架；请求失败后 data 会一直是 null，
          // 这里若继续用 data===null 当 loading，错误态永远显示不出来。
          loading={dishes.loading && dishes.data === null}
          total={dishes.data?.dishes.length ?? 0}
          dishes={listedDishes}
          keyword={keyword}
          servingsOf={servingsOf}
          ingredientHits={ingredientHits}
          stockInfo={stockInfo}
          error={dishes.error}
          onRetry={dishes.reload}
          onAdd={(dish) => addDish(dish)}
          onOpen={setDetail}
          onRequestDish={openRequest}
          onShowAll={() => {
            setKeyword('');
            setCategory('全部');
          }}
        />
      </div>

      <CartBar />

      <IdentityPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        members={members}
        currentId={current?.id ?? null}
        onSelect={(member) => {
          selectMember(member.id);
          setPickerOpen(false);
          toast(`${member.avatar} 已切换为 ${member.name}`, 'success');
        }}
      />

      {/* 点菜目标：给哪天点。之后加入的菜都落到这里，单道菜还能在详情弹层里单独改天 */}
      <Sheet open={targetOpen} onClose={() => setTargetOpen(false)} title="给哪天点菜？">
        <div className="space-y-2 pb-6">
          <p className="text-[12px] leading-5 text-ink-400">
            之后加入的菜都算这一天，餐次用上方选好的「{MEAL_LABEL[mealType]}」。
            单道菜想换天，在它的详情弹层里单独选。
          </p>
          {DAY_OFFSETS.map((offset) => {
            const date = mealDateFromOffset(offset);
            const active = date === targetDate;
            return (
              <button
                key={offset}
                type="button"
                onClick={() => {
                  setTargetDate(date);
                  setTargetOpen(false);
                }}
                className={cn(
                  'press flex w-full items-center justify-between rounded-xl2 border px-3.5 py-3 text-left transition',
                  active ? 'border-brand-300 bg-brand-50' : 'border-cream-300 bg-white',
                )}
              >
                <span className="text-[14px] font-semibold">{dayOffsetLabel(offset)}</span>
                <span className="text-[12px] text-ink-400">
                  {formatDateCN(date)} {formatWeekday(date)}
                </span>
              </button>
            );
          })}
        </div>
      </Sheet>

      {/* 与大厨页共用同一份库存编辑弹层；改完 SSE 会推 fridge:updated，onSaved 只是兜底 */}
      <FridgeStockSheet open={fridgeOpen} onClose={() => setFridgeOpen(false)} onSaved={fridge.reload} />

      <DishDetailSheet
        dish={detail}
        stockIds={stockIds}
        mealType={mealType}
        onClose={() => setDetail(null)}
        feedbacks={detail ? (feedbacksByDish[detail.id] ?? []) : []}
        me={current}
        onFeedbackChanged={() => {
          if (detail) void loadFeedback(detail.id);
        }}
        onDishUpdated={(updated) => {
          // 弹层里传了新图：就地换成最新 dish（预览立刻翻过来），列表交给 SSE + reload
          setDetail((prev) => (prev && prev.id === updated.id ? updated : prev));
          dishes.reload();
        }}
        cartServings={detail ? servingsOf.get(detail.id) : undefined}
        servings={detailServings}
        onSelectServings={setDetailServings}
        day={detailDay}
        onSelectDay={setDetailDay}
        onAdd={addDish}
        onRequestHide={setPendingHide}
      />

      <DishHideConfirmSheet
        dish={pendingHide}
        onClose={() => setPendingHide(null)}
        onConfirm={() => void hideDish()}
        hiding={hiding}
      />

      <ComboSheet
        dishes={combo}
        mealType={mealType}
        headcount={headcount}
        onClose={() => setCombo(null)}
        onRebuild={() => void buildCombo()}
        onAddAll={addCombo}
      />

      <DishRequestSheet
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        name={requestName}
        onNameChange={setRequestName}
        note={requestNote}
        onNoteChange={setRequestNote}
        submitting={requesting}
        submitterName={current?.name ?? null}
        onSubmit={() => void submitRequest()}
      />
    </div>
  );
}

/**
 * 页头副标题的第三段（还剩 X 分 / 已截单 / 提前点）。
 * 自带 useNow：30 秒一次的时间跳动只重渲染这一小片，
 * 不再带着整页菜品网格（DishCard×N）每 30s 全量重渲染。
 */
function CutoffCountdown({
  targetDate,
  settings,
  mealType,
}: {
  targetDate: string;
  settings: AppSettings | null;
  mealType: MealType;
}) {
  const now = useNow();
  const countdown = useMemo(() => cutoffCountdown(cutoffFor(settings, mealType), now), [settings, mealType, now]);
  // 页面开着跨过零点时，「今天」的判断也要跟上：目标日变成过去式就退回「提前点」
  if (targetDate !== todayISO(now)) return <>提前点</>;
  if (countdown.passed) return <>已截单</>;
  // 页头副标题在 390px 下还要给身份/随机留位置，倒计时必须说短：
  // 完整版“距截单还有 34 分钟”会被截成“距截单还有 34 ...”，等于没说。
  const short =
    countdown.minutesLeft >= 60
      ? `${Math.floor(countdown.minutesLeft / 60)}小时${countdown.minutesLeft % 60}分`
      : `${countdown.minutesLeft}分`;
  return <>还剩{short}</>;
}
