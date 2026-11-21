/**
 * 购物车分单提交：按 (日期, 餐次) 逐组提交，幂等 token 的生命周期收在这里。
 *
 * token 规则是「每组成功后立即释放」：
 * - 某组成功后，调用方会把这组从购物车摘掉（菜已经下过了，不该再让用户改）；
 * - 失败的组保留自己的 token，重试时复用它，服务端按 client_token 幂等返回原单——
 *   不会重复下单（采购 / 备料 / 统计不会翻倍）；
 * - 已成功的组释放 token，之后用户再往同一 (日期, 餐次) 加点菜会拿到全新 token，
 *   不会被服务端当成上一笔的重复提交把新菜静默吞掉。
 */
export interface SubmitGroup {
  /** 分组标识（如「日期|餐次」）：幂等 token 的键 */
  key: string;
  /** 用指定 token 提交这一组；失败直接抛错，由调用方决定怎么提示与重试 */
  submit: (clientToken: string) => Promise<unknown>;
}

export async function submitGroups(
  groups: SubmitGroup[],
  tokens: Map<string, string>,
  newToken: () => string,
  /** 每组提交成功后的回调（调用方据此把该组从购物车摘掉） */
  onGroupSucceeded?: (group: SubmitGroup) => void,
  /**
   * 新 token 生成后的回调：调用方必须把它持久化。
   * 只在内存里的话，服务端已建单但响应丢失时，刷新页面后会拿新 token 重复下单。
   */
  onTokenCreated?: (key: string, token: string) => void,
): Promise<void> {
  for (const group of groups) {
    if (!tokens.has(group.key)) {
      const token = newToken();
      tokens.set(group.key, token);
      onTokenCreated?.(group.key, token);
    }
    await group.submit(tokens.get(group.key) as string);
    tokens.delete(group.key);
    onGroupSucceeded?.(group);
  }
}
