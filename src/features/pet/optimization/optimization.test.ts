import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectPool } from './ObjectPool';
import { TextureCache } from './TextureCache';
import { PerformanceMonitor } from './PerformanceMonitor';

describe('ObjectPool', () => {
  it('should create object pool', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; }
    );
    expect(pool).toBeDefined();
  });

  it('should acquire object from pool', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5, // initialSize
      10 // maxSize
    );
    const obj = pool.acquire();
    expect(obj).toBeDefined();
    expect(obj.value).toBe(0);
  });

  it('should release object back to pool', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5, // initialSize
      10 // maxSize
    );
    const obj = pool.acquire();
    pool.release(obj);
    expect(pool.size).toBe(5); // 5 initial - 1 acquired + 1 released = 5
  });

  it('should reuse released objects', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5, // initialSize
      10 // maxSize
    );
    const obj1 = pool.acquire();
    obj1.value = 42;
    pool.release(obj1);
    const obj2 = pool.acquire();
    expect(obj2).toBe(obj1);
    expect(obj2.value).toBe(0); // Should be reset
  });

  it('should create new object when pool is empty', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      0, // Initial size 0
      10 // maxSize
    );
    const obj = pool.acquire();
    expect(obj).toBeDefined();
  });

  it('should not exceed max size', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      0,
      2 // Max size 2
    );
    const obj1 = pool.acquire();
    const obj2 = pool.acquire();
    const obj3 = pool.acquire();
    pool.release(obj1);
    pool.release(obj2);
    pool.release(obj3); // Should not be added
    expect(pool.size).toBe(2);
  });

  it('should clear pool', () => {
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      5,
      10
    );
    pool.clear();
    expect(pool.size).toBe(0);
  });
});

describe('TextureCache', () => {
  it('should create texture cache', () => {
    const cache = new TextureCache();
    expect(cache).toBeDefined();
  });

  it('should get cache size', () => {
    const cache = new TextureCache();
    expect(cache.size).toBe(0);
  });

  it('should set and get texture', () => {
    const cache = new TextureCache();
    cache.set('test', { id: 1 });
    expect(cache.get('test')).toEqual({ id: 1 });
  });

  it('should check if texture exists', () => {
    const cache = new TextureCache();
    cache.set('test', { id: 1 });
    expect(cache.has('test')).toBe(true);
    expect(cache.has('nonexistent')).toBe(false);
  });

  it('should delete texture', () => {
    const cache = new TextureCache();
    cache.set('test', { id: 1 });
    cache.delete('test');
    expect(cache.has('test')).toBe(false);
  });

  it('should clear cache', () => {
    const cache = new TextureCache();
    cache.set('test1', { id: 1 });
    cache.set('test2', { id: 2 });
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('should evict oldest when cache is full', () => {
    const cache = new TextureCache(2);
    cache.set('item1', { id: 1 });
    cache.set('item2', { id: 2 });
    cache.set('item3', { id: 3 }); // Should evict item1
    expect(cache.size).toBe(2);
    expect(cache.has('item1')).toBe(false);
    expect(cache.has('item3')).toBe(true);
  });
});

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  it('should create performance monitor', () => {
    expect(monitor).toBeDefined();
  });

  it('should get FPS', () => {
    const fps = monitor.getFPS();
    expect(typeof fps).toBe('number');
    expect(fps).toBeGreaterThanOrEqual(0);
  });

  it('should get memory usage', () => {
    const memory = monitor.getMemoryUsage();
    // memory can be null in test environment
    expect(memory === null || typeof memory === 'object').toBe(true);
  });

  it('should set FPS threshold', () => {
    monitor.setFPSThreshold(25);
    // Should not throw
  });

  it('should set memory threshold', () => {
    monitor.setMemoryThreshold(0.9);
    // Should not throw
  });

  it('should register and remove alert callback', () => {
    const callback = vi.fn();
    monitor.onAlert(callback);
    monitor.removeAlert(callback);
    // Should not throw
  });

  it('should record frame', () => {
    monitor.recordFrame();
    // Should not throw
  });
});
