import { useState, useEffect, useRef } from 'react';

/**
 * 异步解析 Hook，用于消除重复的 AI 解析管线。
 *
 * 内部使用 ref 追踪请求序号，防止竞态条件。
 * deps 变化时自动重新解析。
 *
 * @param fallback - 初始值及加载中的回退值
 * @param deps - 依赖数组，变化时触发重新解析
 * @param resolver - 异步解析函数，接收 deps 中的每个元素作为参数
 * @returns 解析后的值（初始为 fallback，解析成功后更新）
 *
 * @example
 * ```tsx
 * const mood = useAsyncResolved(
 *   defaultMood,
 *   [bondTier, personality, personalitySummary],
 *   async (bt, p, ps) => {
 *     const result = await resolveMood({ bondTier: bt, personality: p, personalitySummary: ps });
 *     return result ?? undefined;
 *   }
 * );
 * ```
 */
export function useAsyncResolved<T, D extends readonly unknown[]>(
  fallback: T,
  deps: D,
  resolver: (...args: D) => Promise<T | undefined | null>
): T {
  const [value, setValue] = useState<T>(fallback);
  const seqRef = useRef<number>(0);
  const [prevDeps, setPrevDeps] = useState<D>(deps);

  // deps 变化时在渲染期直接重置为 fallback（React 官方的 render 调整模式），
  // 避免 effect 内同步 setState 造成级联渲染。
  if (!depsMatch(prevDeps, deps)) {
    setPrevDeps(deps);
    setValue(fallback);
  }

  useEffect(() => {
    const requestSeq = ++seqRef.current;

    void resolver(...deps).then((result) => {
      // 竞态检查：如果在此期间有新的请求发起，则忽略本次结果
      if (requestSeq !== seqRef.current) return;

      // 只有当 result 非空时才更新
      if (result != null) {
        setValue(result);
      }
    });

    // cleanup 不需要额外处理，seqRef 会在下一次 effect 执行时递增
  }, [...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  return value;
}

function depsMatch(a: readonly unknown[], b: readonly unknown[]) {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
}
