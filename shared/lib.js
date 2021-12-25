/* global sauce */

let sauce;
try {
    sauce = require('./base.js');
    module.exports = sauce;
} catch(e) {
    sauce = self.sauce;
}

sauce.ns('data', function() {
    'use strict';

    function sum(data, offt) {
        let total = 0;
        for (let i = offt || 0, len = data.length; i < len; i++) {
            total += data[i];
        }
        return total;
    }


    function avg(data, offt) {
        if (!data || !data.length) {
            return;
        }
        return sum(data, offt) / (data.length - (offt || 0));
    }


    function max(data, options={}) {
        // Avoid stack overflow by only use Math.max on small arrays
        if (!data || (!options.index && data.length < 65535)) {
            return Math.max.apply(null, data);
        } else {
            let m;
            let index;
            let i = 0;
            for (const x of data) {
                if (m === undefined || x > m) {
                    m = x;
                    index = i;
                }
                i++;
            }
            return options.index ? index : m;
        }
    }


    function min(data, options={}) {
        // Avoid stack overflow by only use Math.min on small arrays
        if (!data || (!options.index && data.length < 65535)) {
            return Math.min.apply(null, data);
        } else {
            let m;
            let index;
            let i = 0;
            for (const x of data) {
                if (m === undefined || x < m) {
                    m = x;
                    index = i;
                }
                i++;
            }
            return options.index ? index : m;
        }
    }


    function mode(data) {
        // Calc math mode for a data array.
        if (!data || !data.length) {
            return;
        }
        const countMap = {};
        let mostFreq;
        for (const value of data) {
            const count = value in countMap ? countMap[value] + 1 : 1;
            countMap[value] = count;
            if (!mostFreq || mostFreq.count < count) {
                mostFreq = {count, value};
                if (count > data.length / 2) {
                    break;  // Nobody can possibly overtake now.
                }
            }
        }
        return mostFreq && mostFreq.value;
    }


    function median(data) {
        // Calc math median for a data array.
        if (!data || !data.length) {
            return;
        }
        const sorted = Array.from(data).sort((a, b) => a - b);
        const midPoint = sorted.length / 2;
        if (sorted.length % 2) {
            return sorted[Math.floor(midPoint)];
        } else {
            // even length calls for avg of middle pair.
            return (sorted[midPoint - 1] + sorted[midPoint]) / 2;
        }
    }


    function stddev(data) {
        const mean = sauce.data.avg(data);
        const variance = data.map(x => (mean - x) ** 2);
        return Math.sqrt(sauce.data.avg(variance));
    }


    function resample(inData, outLen, options={}) {
        const smoothing = options.smoothing || 0.10;
        const inLen = inData.length;
        const step = inLen / outLen;
        const period = Math.round(step * smoothing);
        if (period >= 2) {
            inData = smooth(period, inData);
        }
        const outData = [];
        for (let i = 0; i < outLen; i++) {
            // Round 0.5 down to avoid single use of index 0 and tripple use of final index.
            outData.push(inData[Math.min(inLen - 1, -Math.round(-i * step))]);
        }
        return outData;
    }


    function createActiveStream(streams, options={}) {
        // Some broken time streams have enormous gaps.
        const maxImmobileGap = options.maxImmobileGap != null ? options.maxImmobileGap : 300;
        const useCadence = options.isTrainer || options.isSwim;
        const timeStream = streams.time;
        const movingStream = streams.moving;
        const cadenceStream = useCadence && streams.cadence;
        const wattsStream = streams.watts;
        const distStream = streams.distance;
        const activeStream = [];
        const speedMin = 0.447;  // meter/second (1mph)
        for (let i = 0; i < movingStream.length; i++) {
            activeStream.push(!!(
                movingStream[i] ||
                (!i || timeStream[i] - timeStream[i - 1] < maxImmobileGap) && (
                    (cadenceStream && cadenceStream[i]) ||
                    (wattsStream && wattsStream[i]) ||
                    (distStream && i &&
                     (distStream[i] - distStream[i - 1]) /
                     (timeStream[i] - timeStream[i - 1]) >= speedMin))
            ));
        }
        return activeStream;
    }


    function activeTime(timeStream, activeStream) {
        if (timeStream.length < 2) {
            return 0;
        }
        let maxGap;
        if (activeStream == null) {
            maxGap = recommendedTimeGaps(timeStream).max;
        }
        let accumulated = 0;
        let last = timeStream[0];
        for (let i = 0; i < timeStream.length; i++) {
            const ts = timeStream[i];
            const delta = ts - last;
            if (maxGap != null) {
                if (delta <= maxGap) {
                    accumulated += delta;
                }
            } else {
                if (activeStream[i]) {
                    accumulated += delta;
                }
            }
            last = ts;
        }
        return accumulated;
    }


    let _timeGapsCache = new Map();
    function recommendedTimeGaps(timeStream) {
        const hash = `${timeStream.length}-${timeStream[0]}-${timeStream[timeStream.length - 1]}`;
        if (!_timeGapsCache.has(timeStream) || _timeGapsCache.get(timeStream).hash !== hash) {
            const gaps = timeStream.map((x, i) => timeStream[i + 1] - x);
            gaps.pop();  // last entry is not a number (NaN)
            const ideal = sauce.data.mode(gaps) || 1;
            _timeGapsCache.set(timeStream, {
                hash,
                value: {
                    ideal,
                    max: Math.round(Math.max(ideal, sauce.data.median(gaps))) * 4
                }
            });
        }
        return _timeGapsCache.get(timeStream).value;
    }


    function *range(startOrCount, stop, step) {
        step = step || 1;
        let start;
        if (stop == null) {
            start = 0;
            stop = startOrCount;
        } else {
            start = startOrCount;
        }
        let last;
        for (let i = start; i < stop; i += step) {
            if (last !== undefined) {
                // Prevent infinite loop when step and value are huge/tiny due to ieee754.
                for (let j = 2; last === i; j++) {
                    i += j * step;
                }
            }
            yield i;
            last = i;
        }
    }


    class Pad extends Number {}


    class Zero extends Pad {}


    class Break extends Zero {
        constructor(pad) {
            super(0);
            this.pad = pad;
        }
    }


    class RollingBase {
        constructor(period, options) {
            options = options || {};
            this.period = period || undefined;
            this._times = [];
            this._values = [];
            this._offt = 0;
            this._length = 0;
        }

        clone(options={}) {
            const instance = new this.constructor(options.period || this.period);
            instance._times = this._times;
            instance._values = this._values;
            instance._offt = this._offt;
            instance._length = this._length;
            return instance;
        }

        slice(startTime, endTime) {
            const clone = this.clone();
            if (startTime < 0) {
                startTime = clone.lastTime() + startTime;
            }
            while (clone.firstTime() < startTime) {
                clone.shift();
            }
            if (endTime != null) {
                while (clone.lastTime() > endTime) {
                    clone.pop();
                }
            }
            return clone;
        }

        *_importIter(times, values) {
            if (times.length !== values.length) {
                throw new TypeError("times and values not same length");
            }
            for (let i = 0; i < times.length; i++) {
                yield this.add(times[i], values[i]);
            }
        }

        importData(times, values) {
            if (times.length !== values.length) {
                throw new TypeError("times and values not same length");
            }
            for (let i = 0; i < times.length; i++) {
                this.add(times[i], values[i]);
            }
        }

        importReduce(times, values, comparator) {
            let leader;
            for (const x of this._importIter(times, values)) {
                void x;
                if (this.full() && (!leader || comparator(this, leader))) {
                    leader = this.clone();
                }
            }
            return leader;
        }

        elapsed(options) {
            options = options || {};
            const len = this._length;
            const offt = (options.offt || 0) + this._offt;
            if (len - offt <= 1) {
                return 0;
            }
            return this._times[len - 1] - this._times[offt];
        }

        add(ts, value) {
            this._times.push(ts);
            this._values.push(value);
            this.resize(1);
            return value;
        }

        resize(size) {
            const length = size ? this._length + size : this._values.length;
            if (length > this._values.length) {
                throw new Error('resize underflow');
            }
            for (let i = this._length; i < length; i++) {
                this.processIndex(i);
            }
            this._length = length;
            while (this.full({offt: 1})) {
                this.shift();
            }
        }

        processIndex(index) {
        }

        shiftValue() {
        }

        popValue() {
        }

        firstTime(options) {
            options = options || {};
            if (options.noPad) {
                for (let i = this._offt; i < this._length; i++) {
                    if (!(this._values[i] instanceof Pad)) {
                        return this._times[i];
                    }
                }
            } else {
                return this._times[this._offt];
            }
        }

        lastTime(options) {
            options = options || {};
            if (options.noPad) {
                for (let i = this._length - 1; i >= this._offt; i--) {
                    if (!(this._values[i] instanceof Pad)) {
                        return this._times[i];
                    }
                }
            } else {
                return this._times[this._length - 1];
            }
        }

        size() {
            return this._length - this._offt;
        }

        values() {
            return this._values.slice(this._offt, this._length);
        }

        times() {
            return this._times.slice(this._offt, this._length);
        }

        *entries() {
            for (let i = this._offt; i < this._length; i++) {
                yield [this._times[i], this._values[i]];
            }
        }

        shift() {
            this.shiftValue(this._values[this._offt++]);
        }

        pop() {
            this._length--;
            const value = this._values[this._length];
            this.popValue(value, this._length);
        }

        full(options={}) {
            const offt = options.offt;
            return this.elapsed({offt}) >= this.period;
        }
    }


    class RollingAverage extends RollingBase {
        constructor(period, options) {
            super(period);
            options = options || {};
            this._ignoreZeros = options.ignoreZeros;
            if (this._ignoreZeros) {
                this._zeros = 0;
            }
            this._sum = 0;
        }

        avg(options) {
            options = options || {};
            if (options.active) {
                // XXX this is wrong.  active != ignore zeros  It means ignore gaps we zero padded.
                const count = (this._length - this._offt - (this._zeros || 0));
                return count ? this._sum / count : 0;
            } else {
                if (this._ignoreZeros) {
                    throw new TypeError("Elasped avg unsupported when ignoreZeros=true");
                }
                return (this._sum - this._values[this._offt]) / this.elapsed();
            }
        }

        processIndex(i) {
            const value = this._values[i];
            this._sum += value;
            if (this._ignoreZeros && !value) {
                this._zeros++;
            }
        }

        shiftValue(value) {
            this._sum -= value;
            if (this._ignoreZeros && !value) {
                this._zeros--;
            }
        }

        popValue(value) {
            this._sum -= value;
            if (this._ignoreZeros && !value) {
                this._zeros--;
            }
        }

        clone(...args) {
            const instance = super.clone(...args);
            instance._sum = this._sum;
            instance._ignoreZeros = this._ignoreZeros;
            instance._zeros = this._zeros;
            return instance;
        }
    }


    function peakAverage(period, timeStream, valuesStream, options) {
        if (timeStream.length < 2 || timeStream[timeStream.length - 1] < period) {
            return;
        }
        options = options || {};
        const active = options.active;
        const ignoreZeros = options.ignoreZeros;
        const roll = new RollingAverage(period, {ignoreZeros});
        return roll.importReduce(timeStream, valuesStream,
            (cur, lead) => cur.avg({active}) >= lead.avg({active}));
    }


    function smooth(period, valuesStream) {
        const values = [];
        const roll = new RollingAverage(period);
        for (let i = 0; i < valuesStream.length; i++) {
            const v = valuesStream[i];
            if (i < period - 1) {
                // soften the leading edge by unweighting the first values.
                const weighted = valuesStream.slice(i, period - 1);
                weighted.push(v);
                roll.add(i, avg(weighted));
            } else {
                roll.add(i, v);
            }
            values.push(roll.avg({active: true}));
        }
        return values;
    }


    function overlap([aStart, aEnd], [bStart, bEnd]) {
        const interStart = Math.max(aStart, bStart);
        const interEnd = Math.min(aEnd, bEnd);
        const overlap = interEnd - interStart;
        return overlap < 0 ? null : overlap + 1;
    }


    return {
        sum,
        avg,
        min,
        max,
        mode,
        median,
        stddev,
        resample,
        createActiveStream,
        activeTime,
        recommendedTimeGaps,
        range,
        RollingBase,
        RollingAverage,
        Break,
        Zero,
        Pad,
        peakAverage,
        smooth,
        overlap,
    };
});


sauce.ns('power', function() {
    'use strict';

    /* Based on Andy Coggan's power profile. */
    const rankConstants = {
        male: {
            high: {
                slopeFactor: 2.82,
                slopePeriod: 2500,
                slopeAdjust: 1.4,
                slopeOffset: 3.6,
                baseOffset: 6.08
            },
            low: {
                slopeFactor: 2,
                slopePeriod: 3000,
                slopeAdjust: 1.3,
                slopeOffset: 1,
                baseOffset: 1.74
            }
        },
        female: {
            high: {
                slopeFactor: 2.65,
                slopePeriod: 2500,
                slopeAdjust: 1,
                slopeOffset: 3.6,
                baseOffset: 5.39
            },
            low: {
                slopeFactor: 2.15,
                slopePeriod: 300,
                slopeAdjust: 6,
                slopeOffset: 1.5,
                baseOffset: 1.4
            }
        }
    };

    const npMinTime = 300;  // Andy says 20, but we're rebels.
    const xpMinTime = 300;

    const badgeURN = `${sauce.extUrl}images/ranking`;
    const rankLevels = [{
        levelRequirement: 7 / 8,
        label: 'World Class',
        cat: 'world-tour'
    }, {
        levelRequirement: 6 / 8,
        label: 'Pro',
        cat: 'pro'
    }, {
        levelRequirement: 5 / 8,
        label: 'Cat 1',
        cat: 'cat1'
    }, {
        levelRequirement: 4 / 8,
        label: 'Cat 2',
        cat: 'cat2'
    }, {
        levelRequirement: 3 / 8,
        label: 'Cat 3',
        cat: 'cat3'
    }, {
        levelRequirement: 2 / 8,
        label: 'Cat 4',
        cat: 'cat4'
    }, {
        levelRequirement: 1 / 8,
        label: 'Cat 5',
        cat: 'cat5'
    }, {
        levelRequirement: -Infinity,
        label: 'Recreational'
    }];


    function _rankScaler(duration, c) {
        // XXX Might want to cache this since we use it in the perf calcs now.. Benchmark...
        const t = (c.slopePeriod / duration) * c.slopeAdjust;
        const slope = Math.log10(t + c.slopeOffset);
        const wKgDifference = Math.pow(slope, c.slopeFactor);
        // This is an unscientific extrapolation of power loss associated with endurance
        // efforts over 1 hour.  TODO: Find some real studies.  Currently I'm basing this on
        // Mvdp's stunning Strade Bianchi: https://www.strava.com/activities/4901472414
        const enduroFactor = duration > 3600 ? 1 / ((Math.log(duration / 3600) * 0.1) + 1) : 1;
        return (wKgDifference + c.baseOffset) * enduroFactor;
    }


    function rankRequirements(duration, gender) {
        const high = _rankScaler(duration, rankConstants[gender].high);
        const low = _rankScaler(duration, rankConstants[gender].low);
        return {high, low};
    }


    function rankWeightedRatio(duration) {
        const intro = 1200;
        const outro = 3600;
        return Math.min(1, Math.max(0, (duration - intro) / (outro - intro)));
    }


    function rankLevel(duration, p, wp, weight, gender) {
        const high = _rankScaler(duration, rankConstants[gender].high);
        const low = _rankScaler(duration, rankConstants[gender].low);
        const weightedRatio = (!wp || wp < p) ? 0 : rankWeightedRatio(duration);
        const weightedPower = (weightedRatio * (wp || 0)) + ((1 - weightedRatio) * p);
        const wKg = weightedPower / weight;
        return {
            level: (wKg - low) / (high - low),
            weightedRatio,
            weightedPower,
            wKg,
        };
    }


    function rankBadge({level, weightedRatio, weightedPower, wKg}) {
        const suffix = (document.documentElement.classList.contains('sauce-theme-dark')) ?
            '-darkbg.png' : '.png';
        let lastRankLevel = 1;
        for (const x of rankLevels) {
            if (level >= x.levelRequirement) {
                const catLevel = (level - x.levelRequirement) / (lastRankLevel - x.levelRequirement);
                const tooltip = [
                    `World Ranking: ${Math.round(level * 100).toLocaleString()}%\n`,
                    `${x.label} Ranking: ${Math.round(catLevel * 100).toLocaleString()}%\n`,
                    weightedRatio ? 'Weighted ' : '',
                    `Power: ${wKg.toFixed(1)}w/kg | ${Math.round(weightedPower).toLocaleString()}w\n`,
                ].join('');
                return {
                    level,
                    catLevel,
                    badge: x.cat && `${badgeURN}/${x.cat}${suffix}`,
                    weightedPower,
                    weightedRatio,
                    wKg,
                    tooltip,
                    ...x
                };
            }
            lastRankLevel = x.levelRequirement;
        }
    }


    function rank(duration, p, wp, weight, gender) {
        return rankBadge(rankLevel(duration, p, wp, weight, gender));
    }


    class RollingPower extends sauce.data.RollingBase {
        constructor(period, options={idealGap: 1, breakGap: 3600}) {
            super(period);
            this._joules = 0;
            this._gapPadCount = 0;
            this.idealGap = options.idealGap;
            this.maxGap = options.maxGap;
            this.breakGap = options.breakGap;
            this._active = options.active;
            if (options.inlineNP) {
                const sampleRate = 1 / this.idealGap;
                const rollSize = Math.round(30 * sampleRate);
                this._inlineNP = {
                    saved: [],
                    rollSize,
                    slot: 0,
                    roll: new Array(rollSize),
                    rollSum: 0,
                    total: 0,
                };
            }
            if (options.inlineXP) {
                const samplesPerWindow = 25 / this.idealGap;
                this._inlineXP = {
                    saved: [],
                    samplesPerWindow,
                    attenuation: samplesPerWindow / (samplesPerWindow + this.idealGap),
                    sampleWeight: this.idealGap / (samplesPerWindow + this.idealGap),
                    prevTime: 0,
                    weighted: 0,
                    breakPadding: 0,
                    count: 0,
                    total: 0,
                };
            }
        }

        add(ts, value) {
            if (this._length) {
                const prevTS = this._times[this._length - 1];
                const gap = ts - prevTS;
                if (this.maxGap && gap > this.maxGap) {
                    const zeroPad = new sauce.data.Zero();
                    let idealGap = this.idealGap;
                    if (!idealGap) {
                        const gaps = sauce.data.recommendedTimeGaps(this.times());
                        idealGap = gaps.ideal || 1;
                    }
                    if (gap > this.breakGap) {
                        // Handle massive gaps between time stamps seen by Garmin devices glitching.
                        // Note, to play nice with elapsed time based rolling avgs, we include the
                        // max number of zero pads on either end of the gap.
                        const bookEndTime = Math.floor(this.breakGap / 2) - idealGap;
                        for (let i = idealGap; i < bookEndTime; i += idealGap) {
                            super.add(prevTS + i, zeroPad);
                        }
                        super.add(prevTS + bookEndTime, new sauce.data.Break(gap - (bookEndTime * 2)));
                        for (let i = gap - bookEndTime; i < gap; i += idealGap) {
                            super.add(prevTS + i, zeroPad);
                        }
                    } else {
                        for (let i = idealGap; i < gap; i += idealGap) {
                            super.add(prevTS + i, zeroPad);
                        }
                    }
                } else if (this.idealGap && gap > this.idealGap) {
                    for (let i = this.idealGap; i < gap; i += this.idealGap) {
                        super.add(prevTS + i, new sauce.data.Pad(value));
                    }
                }
            }
            return super.add(ts, value);
        }

        processIndex(i) {
            const ts = this._times[i];
            const value = this._values[i];
            const gap = i ? Math.max(0, ts - this._times[i - 1]) : 0;
            if (value * gap > 1000) {
                console.warn("big value", value, gap);
            }
            this._joules += value * gap;
            if (this._joules < -1) {
                console.warn("Negative energy", this._joules);
            }
            if (value instanceof sauce.data.Zero) {
                this._gapPadCount++;
            }
            if (this._inlineNP) {
                const state = this._inlineNP;
                const saved = {};
                const slot = i % state.rollSize;
                if (value instanceof sauce.data.Zero) {
                    // Drain the rolling buffer but don't increment the counter.
                    state.rollSum -= state.roll[slot] || 0;
                    state.roll[slot] = 0;
                } else {
                    state.rollSum += value;
                    state.rollSum -= state.roll[slot] || 0;
                    state.roll[slot] = value;
                    const npa = state.rollSum / Math.min(state.rollSize, i + 1 - this._offt);
                    const qnpa = npa * npa * npa * npa;  // unrolled for perf
                    state.total += qnpa;
                    saved.value = qnpa;
                }
                state.saved.push(saved);
            }
            if (this._inlineXP) {
                const state = this._inlineXP;
                const saved = {};
                if (value instanceof sauce.data.Zero) {
                    if (value instanceof sauce.data.Break) {
                        state.breakPadding += value.pad;
                        saved.breakPadding = value.pad;
                    }
                } else {
                    const epsilon = 0.1;
                    const negligible = 0.1;
                    const time = (i * this.idealGap) + state.breakPadding;
                    let count = 0;
                    while ((state.weighted > negligible) &&
                           time > state.prevTime + this.idealGap + epsilon) {
                        state.weighted *= state.attenuation;
                        state.prevTime += this.idealGap;
                        const w = state.weighted;
                        state.total += w * w * w * w;  // unroll for perf
                        count++;
                    }
                    state.weighted *= state.attenuation;
                    state.weighted += state.sampleWeight * value;
                    state.prevTime = time;
                    const w = state.weighted;
                    const qw = w * w * w * w;  // unrolled for perf
                    state.total += qw;
                    count++;
                    state.count += count;
                    saved.value = qw;
                    saved.count = count;
                }
                state.saved.push(saved);
            }
        }

        shiftValue(value) {
            if (value instanceof sauce.data.Zero) {
                this._gapPadCount--;
            }
            const i = this._offt - 1;
            const gap = this._length > 1 ? this._times[i + 1] - this._times[i] : 0;
            this._joules -= this._values[i + 1] * gap;
            if (this._inlineNP) {
                const state = this._inlineNP;
                const saved = state.saved[i];
                state.total -= saved.value || 0;
            }
            if (this._inlineXP) {
                const state = this._inlineXP;
                const saved = state.saved[i];
                state.total -= saved.value || 0;
                state.count -= saved.count || 0;
                state.breakPadding -= saved.breakPadding || 0;
            }
        }

        popValue(value, popIndex) {
            const gap = popIndex >= 1 ? this._times[popIndex] - this._times[popIndex - 1] : 0;
            this._joules -= value * gap;
            if (this._inlineNP || this._inlineXP) {
                throw new Error("Unsupported");
            }
        }

        avg() {
            return this._joules / this.elapsed();
        }

        activeOld(options={}) {
            const count = this.size() - (options.offt || 0) - this._gapPadCount;
            // Subtract the first record as it doesn't indicate a time quanta, just the start ref.
            return (count - 1) * (this.idealGap || 1);
        }

        active() {
            let s = 0;
            for (let i = this._offt; i < this._length; i++) {
                if (this._values[i] instanceof sauce.data.Zero) {
                    continue;
                }
                const gap = i ? this._times[i] - this._times[i - 1] : this.idealGap || 1;
                s += gap;
            }
            return s;
        }

        full(options={}) {
            if (this._active || options.active) {
                return this.active(options) >= this.period;
            } else {
                return super.full(options);
            }
        }

        np(options={}) {
            if (this._inlineNP && !options.external) {
                if (this.active() < npMinTime && !options.force) {
                    return;
                }
                const state = this._inlineNP;
                return (state.total / (this.size() - this._gapPadCount)) ** 0.25;
            } else {
                return sauce.power.calcNP(this.values(), 1 / this.idealGap, options);
            }
        }

        xp(options={}) {
            if (this._inlineXP && !options.external) {
                if (this.active() < xpMinTime && !options.force) {
                    return;
                }
                const state = this._inlineXP;
                return (state.total / state.count) ** 0.25;
            } else {
                return sauce.power.calcXP(this.values(), 1 / this.idealGap, options);
            }
        }

        kj() {
            return this._joules / 1000;
        }

        clone(...args) {
            const instance = super.clone(...args);
            instance.idealGap = this.idealGap;
            instance.maxGap = this.maxGap;
            instance.breakGap = this.breakGap;
            instance._joules = this._joules;
            instance._gapPadCount = this._gapPadCount;
            instance._active = this._active;
            if (this._inlineNP) {
                this._copyInlineState('_inlineNP', instance);
            }
            if (this._inlineXP) {
                this._copyInlineState('_inlineXP', instance);
            }
            return instance;
        }

        _copyInlineState(key, target) {
            const saved = this[key].saved;
            target[key] = {...this[key]};
            const offt = saved.length - target._length;
            target[key].saved = saved.slice(offt);
        }
    }


    function correctedRollingPower(timeStream, period, options={}) {
        if (timeStream.length < 2 || timeStream[timeStream.length - 1] < period) {
            return;
        }
        if (options.idealGap == null || options.maxGap == null) {
            const gaps = sauce.data.recommendedTimeGaps(timeStream);
            if (options.idealGap == null) {
                options.idealGap = gaps.ideal;
            }
            if (options.maxGap == null) {
                options.maxGap = gaps.max;
            }
        }
        return new RollingPower(period, options);
    }


    function peakPower(period, timeStream, wattsStream, options) {
        const roll = correctedRollingPower(timeStream, period, options);
        if (!roll) {
            return;
        }
        return roll.importReduce(timeStream, wattsStream, (cur, lead) => cur.avg() >= lead.avg());
    }


    function peakNP(period, timeStream, wattsStream, options) {
        const roll = correctedRollingPower(timeStream, period,
            {inlineNP: true, active: true, ...options});
        if (!roll) {
            return;
        }
        return roll.importReduce(timeStream, wattsStream, (cur, lead) => cur.np() >= lead.np());
    }


    function peakXP(period, timeStream, wattsStream, options) {
        const roll = correctedRollingPower(timeStream, period,
            {inlineXP: true, active: true, ...options});
        if (!roll) {
            return;
        }
        return roll.importReduce(timeStream, wattsStream, (cur, lead) => cur.xp() >= lead.xp());
    }


    function correctedPower(timeStream, wattsStream, options) {
        const roll = correctedRollingPower(timeStream, null, options);
        if (!roll) {
            return;
        }
        roll.importData(timeStream, wattsStream);
        return roll;
    }


    function calcNP(stream, sampleRate, options={}) {
        /* Coggan doesn't recommend NP for less than 20 mins, but we're outlaws
         * and we go as low as 5 mins now! (10-08-2020) */
        sampleRate = sampleRate || 1;
        if (!options.force) {
            const elapsed = stream.length / sampleRate;
            if (!stream || elapsed < npMinTime) {
                return;
            }
        }
        const rollingSize = Math.round(30 * sampleRate);
        if (rollingSize < 2) {
            // Sample rate is too low for meaningful data.
            return;
        }
        const rolling = new Array(rollingSize);
        let total = 0;
        let count = 0;
        let breakPadding = 0;
        for (let i = 0, sum = 0, len = stream.length; i < len; i++) {
            const index = i % rollingSize;
            const watts = stream[i];
            // Drain the rolling buffer but don't increment the counter for gaps...
            if (watts instanceof sauce.data.Break) {
                for (let j = 0; j < Math.min(rollingSize, watts.pad); j++) {
                    const rollIndex = (index + j) % rollingSize;
                    sum -= rolling[rollIndex] || 0;
                    rolling[rollIndex] = 0;
                }
                breakPadding += watts.pad;
                continue;
            } else if (watts instanceof sauce.data.Zero) {
                sum -= rolling[index] || 0;
                rolling[index] = 0;
                continue;
            }
            sum += watts;
            sum -= rolling[index] || 0;
            rolling[index] = watts;
            const avg = sum / Math.min(rollingSize, i + 1 + breakPadding);
            total += avg * avg * avg * avg;  // About 100 x faster than Math.pow and **
            count++;
        }
        return (total / count) ** 0.25;
    }


    function calcXP(stream, sampleRate, options={}) {
        /* See: https://perfprostudio.com/BETA/Studio/scr/BikeScore.htm
         * xPower is more accurate version of NP that better correlates to how
         * humans recover from oxygen debt. */
        sampleRate = sampleRate || 1;
        if (!options.force) {
            const elapsed = stream.length / sampleRate;
            if (!stream || elapsed < xpMinTime) {
                return;
            }
        }
        const epsilon = 0.1;
        const negligible = 0.1;
        const sampleInterval = 1 / sampleRate;
        const samplesPerWindow = 25 / sampleInterval;
        const attenuation = samplesPerWindow / (samplesPerWindow + sampleInterval);
        const sampleWeight = sampleInterval / (samplesPerWindow + sampleInterval);
        let prevTime = 0;
        let weighted = 0;
        let total = 0;
        let count = 0;
        let breakPadding = 0;
        for (let i = 0, len = stream.length; i < len; i++) {
            const watts = stream[i];
            if (watts instanceof sauce.data.Zero) {
                if (watts instanceof sauce.data.Break) {
                    breakPadding += watts.pad;
                }
                continue; // Skip Zero pads so after the inner while loop can attenuate on its terms.
            }
            const time = (i * sampleInterval) + breakPadding;
            while ((weighted > negligible) && time > prevTime + sampleInterval + epsilon) {
                weighted *= attenuation;
                prevTime += sampleInterval;
                total += weighted * weighted * weighted * weighted;  // unrolled for perf
                count++;
            }
            weighted *= attenuation;
            weighted += sampleWeight * watts;
            prevTime = time;
            total += weighted * weighted * weighted * weighted;  // unrolled for perf
            count++;
        }
        return count ? (total / count) ** 0.25 : 0;
    }


    function calcTSS(power, duration, ftp) {
        const joules = power * duration;
        const ftpHourJoules = ftp * 3600;
        const intensity = power / ftp;
        return ((joules * intensity) / ftpHourJoules) * 100;
    }


    function seaLevelPower(power, el) {
        // Based on research from Bassett, D.R. Jr., C.R. Kyle, L. Passfield, J.P. Broker, and E.R. Burke.
        // 31:1665-76, 1999.
        // Note we assume the athlete is acclimatized for simplicity.
        // acclimated:
        //   vo2maxPct = -1.1219 * km ** 2 - 1.8991 * km + 99.921
        //   R^2 = 0.9729
        // unacclimated:
        //   v02maxPct = 0.1781 * km ** 3 - 1.434 * km ** 2 - 4.0726 ** km + 100.35
        //   R^2 = 0.9739
        const elKm = el / 1000;
        const vo2maxAdjust = (-1.1219 * (elKm * elKm) - 1.8991 * elKm + 99.921) / 100;  // unroll exp for perf
        return power * (1 / vo2maxAdjust);
    }


    function gravityForce(slope, weight) {
        const g = 9.80655;
        return g * Math.sin(Math.atan(slope)) * weight;
    }


    function rollingResistanceForce(slope, weight, crr) {
        const g = 9.80655;
        return g * Math.cos(Math.atan(slope)) * weight * crr;
    }


    function aeroDragForce(cda, p, v, w) {
        const netVelocity = v + w;
        const invert = netVelocity < 0 ? -1 : 1;
        return (0.5 * cda * p * (netVelocity * netVelocity)) * invert;
    }


    function airDensity(el) {
        const p0 = 1.225;
        const g = 9.80655;
        const M0 = 0.0289644;
        const R = 8.3144598;
        const T0 = 288.15;
        return p0 * Math.exp((-g * M0 * el) / (R * T0));
    }


    function cyclingPowerEstimate({velocity, slope, weight, crr, cda, el=0, wind=0, loss=0.035}) {
        const invert = velocity < 0 ? -1 : 1;
        const Fg = gravityForce(slope, weight);
        const Fr = rollingResistanceForce(slope, weight, crr) * invert;
        const Fa = aeroDragForce(cda, airDensity(el), velocity, wind);
        const vFactor = velocity / (1 - loss);  // velocity with mech loss integrated
        return {
            gForce: Fg,
            rForce: Fr,
            aForce: Fa,
            force: Fg + Fr + Fa,
            gWatts: Fg * vFactor * invert,
            rWatts: Fr * vFactor * invert,
            aWatts: Fa * vFactor * invert,
            watts: (Fg + Fr + Fa) * vFactor * invert
        };
    }


    function cyclingDraftDragReduction(riders, position) {
        /* Based on the wonderful work of:
         *    van Druenen, T., Blocken, B.
         *    Aerodynamic analysis of uphill drafting in cycling.
         *    Sports Eng 24, 10 (2021).
         *    https://doi.org/10.1007/s12283-021-00345-2
         *
         * The values from this paper have been curve fitted to an exponential func
         * so we can infer average CdA adaption with dynamic pack positions.
         */
        if (riders == null || position == null) {
            throw new TypeError("riders and position are required arguments");
        }
        if (riders < 2) {
            return 1;
        }
        if (position > riders) {
            throw new TypeError("position must be <= riders");
        }
        if (position < 1) {
            throw new TypeError("position must be >= 1");
        }
        const coefficients = {
            2: {y0: 6.228152, v0: 14.30192, k: 2.501857},
            3: {y0: 3.862857, v0: 6.374476, k: 1.860752},
            4: {y0: 3.167014, v0: 4.37368, k: 1.581374},
            5: {y0: 2.83803, v0: 3.561276, k: 1.452583},
            6: {y0: 2.598001, v0: 2.963105, k: 1.329827},
            7: {y0: 2.556656, v0: 2.86052, k: 1.305172},
            8: {y0: 2.506765, v0: 2.735303, k: 1.272144},
        };
        if (riders > 8) {
            position = Math.max(1, 8 / riders * position);
            riders = 8;
        }
        const c = coefficients[riders];
        return c.y0 - ((c.v0 / c.k) * (1 - Math.exp(-c.k * position)));
    }


    function cyclingPowerVelocitySearchMultiPosition(riders, positions, args) {
        const reductions = positions.map(x => cyclingDraftDragReduction(riders, x.position));
        const avgCda = sauce.data.sum(reductions.map((x, i) => x * positions[i].pct)) * args.cda;
        const seedEst = cyclingPowerFastestVelocitySearch({...args, cda: avgCda});
        if (!seedEst) {
            return;
        }
        const velocity = seedEst.velocity;
        const estimates = reductions.map((x, i) => cyclingPowerEstimate({
            ...args,
            weight: positions[i].weight || args.weight,
            cda: x * args.cda,
            velocity,
        }));
        const estAvg = field => sauce.data.sum(positions.map((x, i) => x.pct * estimates[i][field]));
        if (Math.abs(estAvg('watts') - args.power) > 0.01) {
            sauce.report.error(new Error('velocity from perf search seed is invalid'));
        }
        return {
            gForce: estAvg('gForce'),
            rForce: estAvg('rForce'),
            aForce: estAvg('aForce'),
            force: estAvg('force'),
            gWatts: estAvg('gWatts'),
            rWatts: estAvg('rWatts'),
            aWatts: estAvg('aWatts'),
            watts: estAvg('watts'),
            estimates,
            velocity,
        };
    }


    function cyclingPowerVelocitySearch({power, ...args}) {
        // Do not adjust without running test suite and tuning for 50% tollerance above failure
        const epsilon = 0.000001;
        const sampleSize = 300;
        const filterPct = 0.50;

        function refineRange(start, end) {
            let lastStart;
            let lastEnd;

            function byPowerClosenessOrVelocity(a, b) {
                const deltaA = Math.abs(a[1].watts - power);
                const deltaB = Math.abs(b[1].watts - power);
                if (deltaA < deltaB) {
                    return -1;
                } else if (deltaB < deltaA) {
                    return 1;
                } else {
                    return b[0] - a[0];  // fallback to velocity
                }
            }

            for (let fuse = 0; fuse < 100; fuse++) {
                const results = [];
                const step = Math.max((end - start) / sampleSize, epsilon / sampleSize);
                for (const v of sauce.data.range(start, end + step, step)) {
                    const est = cyclingPowerEstimate({velocity: v, ...args});
                    results.push([v, est]);
                }
                results.sort(byPowerClosenessOrVelocity);
                results.length = Math.min(Math.floor(sampleSize * filterPct), results.length);
                const velocities = results.map(x => x[0]);
                if (velocities.length === 0) {
                    throw new Error("Emnty Range");
                }
                start = sauce.data.min(velocities);
                end = sauce.data.max(velocities);
                if (velocities.length === 1 ||
                    (Math.abs(start - lastStart) < epsilon && Math.abs(end - lastEnd) < epsilon)) {
                    // When multiple solution are in a single range it's possible to be too course
                    // in the steps and then exclude the most optimal solutions that exist outside
                    // the filtered range here.  So we scan out as the last step to ensure we are
                    // inclusive of all optimal solutions.
                    if (step > epsilon) {
                        for (const [iv, dir] of [[start, -1], [end, 1]]) {
                            let bestEst = cyclingPowerEstimate({velocity: iv, ...args});
                            const smallStep = Math.max(step / 100, epsilon) * dir;
                            for (let v = iv + smallStep;; v += smallStep) {
                                const est = cyclingPowerEstimate({velocity: v, ...args});
                                results.push([v, est]);  // Always include the test case.
                                if (Math.abs(est.watts - power) < Math.abs(bestEst.watts - power)) {
                                    bestEst = est;
                                } else {
                                    break;
                                }
                            }
                        }
                        results.sort(byPowerClosenessOrVelocity);
                        return results.map(x => x[0]);
                    }
                    return velocities;
                }
                lastStart = start;
                lastEnd = end;
            }
            throw new Error("No result found");
        }

        function findLocalRanges(velocities) {
            // Search for high energy matches based on stddev outliers. Returns an array
            // of ranges with lower and upper bounds that can be further narrowed.
            const stddev = sauce.data.stddev(velocities);
            const groups = new Map();
            for (const v of velocities) {
                let added = false;
                for (const [x, values] of groups.entries()) {
                    if (Math.abs(v - x) < Math.max(stddev, epsilon * sampleSize * filterPct)) {
                        values.push(v);
                        added = true;
                        break;
                    }
                }
                if (!added) {
                    groups.set(v, [v]);
                }
            }
            return Array.from(groups.values()).filter(x => x.length > 1).map(x =>
                [sauce.data.min(x), sauce.data.max(x)]);
        }

        const matches = [];
        function search(velocities) {
            const outerRanges = findLocalRanges(velocities);
            for (const [lower, upper] of outerRanges) {
                const rangeVs = refineRange(lower, upper);
                const innerRanges = rangeVs.length >= 4 && findLocalRanges(rangeVs);
                if (innerRanges && innerRanges.length > 1) {
                    for (const [lower, upper] of innerRanges) {
                        search(refineRange(lower, upper));
                    }
                } else {
                    const est = cyclingPowerEstimate({velocity: rangeVs[0], ...args});
                    // If the difference is less than epsilon (1 millionth) or we are within epsilon %.
                    // The former is for very small values and the latter is for massive values. Both
                    // are needed!
                    if (Math.abs(est.watts - power) < epsilon ||
                        Math.abs(1 - ((est.watts || epsilon) / (power || epsilon))) < epsilon) {
                        matches.push({velocity: rangeVs[0], ...est});
                    }
                }
            }
        }

        const c = 299792458;  // speed of light
        search(refineRange(-c, c));
        return matches;
    }


    function cyclingPowerFastestVelocitySearch(options) {
        const velocities = cyclingPowerVelocitySearch(options).filter(x => x.velocity > 0);
        velocities.sort((a, b) => b.velocity - a.velocity);
        return velocities[0];
    }


    /*
     * The wPrime math is based on exactly 1 second power data.
     */
    function _wPrimeCorrectedPower(wattsStream, timeStream) {
        return correctedPower(timeStream, wattsStream, {idealGap: 1});
    }

    /*
     * The fast impl of the Skiba W` integral algo.
     * See: http://markliversedge.blogspot.nl/2014/10/wbal-optimisation-by-mathematician.html
     */
    function calcWPrimeBalIntegralStatic(wattsStream, timeStream, cp, wPrime) {
        let sum = 0;
        const wPrimeBal = [];
        const belowCPAvg = sauce.data.avg(wattsStream.filter(x => x != null && x < cp)) || 0;
        const deltaCP = cp - belowCPAvg;
        const tau = 546 * Math.E ** (-0.01 * deltaCP) + 316;
        let prevTime = timeStream[0] - 1; // Somewhat arbitrary.  Alt would be to discard idx 0.
        for (let i = 0; i < timeStream.length; i++) {
            const p = wattsStream[i];
            const t = timeStream[i];
            const sr = 1 / (t - prevTime);  // XXX suspect name, is this actually elapsed time?
            if (sr !== 1) {
                console.warn(t, sr);
            }
            prevTime = t;
            const aboveCP = p > cp ? p - cp : 0;
            const wPrimeExpended = aboveCP * sr;
            sum += wPrimeExpended * Math.E ** (t * sr / tau);
            wPrimeBal.push(wPrime - sum * Math.E ** (-t * sr / tau));
            if (wPrimeBal[wPrimeBal.length - 1] < 0) {
                debugger;
            }
        }
        return wPrimeBal;
    }

    /*
     * The differential algo for W'bal stream.  Aka Froncioni Skiba and Clarke.
     * See: http://markliversedge.blogspot.nl/2014/10/wbal-optimisation-by-mathematician.html
     */
    function calcWPrimeBalDifferential(wattsStream, timeStream, cp, wPrime) {
        const powerRoll = _wPrimeCorrectedPower(wattsStream, timeStream);
        const wPrimeBal = [];
        const epsilon = 0.000001;
        let wBal = wPrime;
        for (const p of powerRoll.values()) {
            if (p instanceof sauce.data.Break) {
                // Refill wBal while we have a break.
                for (let j = 0; j < p.pad; j++) {
                    wBal += cp * (wPrime - wBal) / wPrime;
                    if (wBal >= wPrime - epsilon) {
                        wBal = wPrime;
                        break;
                    }
                }
            } else {
                const pNum = p || 0;  // convert null and undefined to 0.
                wBal += pNum < cp ? (cp - pNum) * (wPrime - wBal) / wPrime : cp - pNum;
            }
            if (wBal > wPrime) {
                debugger;  // XXX shouldn't be possible.
            }
            if (!(p instanceof sauce.data.Pad)) {
                // Our output stream should align with the input stream, not the corrected
                // one used for calculations, so skip pad based values.
                wPrimeBal.push(Math.round(wBal));
            }
        }
        return wPrimeBal;
    }


    function calcPwHrDecouplingFromRoll(powerRoll, hrStream) {
        hrStream = hrStream.filter(x => x);  // exclude any null/invalid readings
        const times = powerRoll.times();
        const midPowerTime = times[Math.floor(times.length / 2)];
        const firstHalf = powerRoll.slice(times[0], midPowerTime);
        const secondHalf = powerRoll.slice(midPowerTime, times[times.length - 1]);
        const midHRIndex = Math.floor(hrStream.length / 2);
        const [np1, np2] = [firstHalf.np(), secondHalf.np()];
        if (!np1 || !np2) {
            return;
        }
        const firstHalfRatio = np1 / sauce.data.avg(hrStream.slice(0, midHRIndex));
        const secondHalfRatio = np2 / sauce.data.avg(hrStream.slice(midHRIndex));
        const r = (firstHalfRatio - secondHalfRatio) / firstHalfRatio;
        if (isNaN(r)) {
            debugger;
        }
        return r;
    }


    function calcPwHrDecoupling(wattsStream, timeStream, hrStream) {
        const powerRoll = correctedPower(timeStream, wattsStream);
        return calcPwHrDecouplingFromRoll(powerRoll, hrStream);
    }


    return {
        peakPower,
        peakNP,
        peakXP,
        correctedPower,
        correctedRollingPower,
        calcNP,
        calcXP,
        calcTSS,
        calcWPrimeBalIntegralStatic,
        calcWPrimeBalDifferential,
        calcPwHrDecouplingFromRoll,
        calcPwHrDecoupling,
        rank,
        rankLevel,
        rankBadge,
        rankRequirements,
        rankWeightedRatio,
        seaLevelPower,
        cyclingPowerEstimate,
        cyclingPowerVelocitySearch,
        cyclingPowerFastestVelocitySearch,
        cyclingPowerVelocitySearchMultiPosition,
        cyclingDraftDragReduction,
        RollingPower,
    };
});


sauce.ns('pace', function() {
    'use strict';

    class RollingPace extends sauce.data.RollingBase {
        distance(options) {
            options = options || {};
            const offt = (options.offt || 0) + this._offt;
            const start = this._values[offt];
            const end = this._values[this._length - 1];
            if (start != null && end != null) {
                return end - start;
            }
        }

        avg() {
            const dist = this.distance();
            const elapsed = this.elapsed();
            if (!dist || !elapsed) {
                return;
            }
            return elapsed / dist;
        }

        full(options) {
            options = options || {};
            const offt = options.offt;
            return this.distance({offt}) >= this.period;
        }
    }


    function bestPace(distance, timeStream, distStream) {
        if (timeStream.length < 2 || distance[distance.length - 1] < distance) {
            return;
        }
        const roll = new RollingPace(distance);
        return roll.importReduce(timeStream, distStream, (cur, lead) => cur.avg() <= lead.avg());
    }


    function work(weight, dist, isWalking) {
        const cost = isWalking ? 2 : 4.35;  // Hand tuned by intuition
        const j = cost / ((1 / weight) * (1 / dist));
        const humanMechFactor = 0.24;  // Human mechanical efficiency percentage
        const kj = j * humanMechFactor / 1000;
        return kj;
    }


    return {
        bestPace,
        work,
    };
});


sauce.ns('geo', function(ns) {
    'use strict';

    function distance([latA, lngA], [latB, lngB]) {
        // haversine method (slow but accurate) - as the crow flies
        const rLatA = latA * Math.PI / 180;
        const rLatB = latB * Math.PI / 180;
        const rDeltaLat = (latB - latA) * Math.PI / 180;
        const rDeltaLng = (lngB - lngA) * Math.PI / 180;
        const rDeltaLatHalfSin = Math.sin(rDeltaLat / 2);
        const rDeltaLngHalfSin = Math.sin(rDeltaLng / 2);
        const a = (rDeltaLatHalfSin * rDeltaLatHalfSin) +
                  (Math.cos(rLatA) * Math.cos(rLatB) *
                   (rDeltaLngHalfSin * rDeltaLngHalfSin));
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return 6371e3 * c;
    }


    function latPad(distance) {
        const mPerDegree = 0.0000089;
        return distance * mPerDegree;
    }


    function lngPad(lat, distance) {
        const mPerDegree = 0.0000089;
        return (distance * mPerDegree) / Math.cos(lat * (Math.PI / 180));
    }


    function boundingBox(latlngStream, options={}) {
        if (!latlngStream || !latlngStream.length) {
            return;
        }
        let necLat = latlngStream[0][0];
        let necLng = latlngStream[0][1];
        let swcLat = latlngStream[0][0];
        let swcLng = latlngStream[0][1];
        for (const [lat, lng] of latlngStream) {
            if (lat > necLat) {
                necLat = lat;
            }
            if (lng > necLng) {
                necLng = lng;
            }
            if (lat < swcLat) {
                swcLat = lat;
            }
            if (lng < swcLng) {
                swcLng = lng;
            }
        }
        if (options.pad) {
            necLat += latPad(options.pad);
            swcLat -= latPad(options.pad);
            necLng += lngPad(necLat, options.pad);
            swcLng -= lngPad(swcLat, options.pad);
        }
        return {
            nec: [necLat, necLng],
            swc: [swcLat, swcLng]
        };
    }


    function inBounds(point, box) {
        // Assumes bbox is true swc and nec..
        return point[0] >= box.swc[0] && point[0] <= box.nec[0] &&
            point[1] >= box.swc[1] && point[1] <= box.nec[1];
    }


    function boundsOverlap(boxA, boxB) {
        const yA = boxA.swc[0];
        const yB = boxB.swc[0];
        const hA = boxA.nec[0] - yA;
        const hB = boxB.nec[0] - yB;
        const top = Math.min(yA + hA, yB + hB);
        const bottom = Math.max(yA, yB);
        if (top - bottom < 0) {
            return false;
        }
        const xA = boxA.swc[1];
        const xB = boxB.swc[1];
        const wA = boxA.nec[1] - xA;
        const wB = boxB.nec[1] - xB;
        const right = Math.min(xA + wA, xB + wB);
        const left = Math.max(xA, xB);
        if (right - left < 0) {
            return false;
        }
        return true;
    }


    class BDCC {
        constructor(lat, lng) {
            const theta = lng * Math.PI / 180.0;
            const rlat = this.geocentricLatitude(lat * Math.PI / 180.0);
            const c = Math.cos(rlat);
            this.x = c * Math.cos(theta);
            this.y = c * Math.sin(theta);
            this.z = Math.sin(rlat);
        }

        // Convert from geographic to geocentric latitude (radians).
        geocentricLatitude(geographicLatitude) {
            const flattening = 1.0 / 298.257223563;  // WGS84
            return Math.atan((Math.tan(geographicLatitude) * ((1.0 - flattening) ** 2)));
        }

        // Convert from geocentric to geographic latitude (radians)
        geographicLatitude(geocentricLatitude) {
            const flattening = 1.0 / 298.257223563;  // WGS84
            return Math.atan(Math.tan(geocentricLatitude) / ((1.0 - flattening) ** 2));
        }

        // Returns the two antipodal points of intersection of two great circles defined by the
        // arcs geo1 to geo2 and geo3 to geo4. Returns a point as a Geo, use .antipode to get the
        // other point
        getIntersection(geo1,  geo2,  geo3,  geo4) {
            const geoCross1 = geo1.crossNormalize(geo2);
            const geoCross2 = geo3.crossNormalize(geo4);
            return geoCross1.crossNormalize(geoCross2);
        }

        radiansToMeters(rad) {
            return rad * 6378137.0;  // WGS84 Equatorial Radius in Meters
        }

        metersToRadians(m) {
            return m / 6378137.0;  // WGS84 Equatorial Radius in Meters
        }

        getLatitudeRadians() {
            return this.geographicLatitude(Math.atan2(this.z,
                Math.sqrt((this.x ** 2) + (this.y ** 2))));
        }

        getLongitudeRadians() {
            return Math.atan2(this.y, this.x);
        }

        getLatitude() {
            return this.getLatitudeRadians() * 180.0 / Math.PI;
        }

        getLongitude() {
            return this.getLongitudeRadians() * 180.0 / Math.PI ;
        }

        dot(b) {
            return (this.x * b.x) + (this.y * b.y) + (this.z * b.z);
        }

        crossLength(b) {
            const x = (this.y * b.z) - (this.z * b.y);
            const y = (this.z * b.x) - (this.x * b.z);
            const z = (this.x * b.y) - (this.y * b.x);
            return Math.sqrt((x * x) + (y * y) + (z * z));
        }

        static scale(s) {
            const r = new this(0, 0);
            r.x = this.x * s;
            r.y = this.y * s;
            r.z = this.z * s;
            return r;
        }

        crossNormalize(b) {
            const x = (this.y * b.z) - (this.z * b.y);
            const y = (this.z * b.x) - (this.x * b.z);
            const z = (this.x * b.y) - (this.y * b.x);
            const L = Math.sqrt((x * x) + (y * y) + (z * z));
            const r = new BDCC(0, 0);
            r.x = x / L;
            r.y = y / L;
            r.z = z / L;
            return r;
        }

        // Point on opposite side of the world from this point.
        antipode() {
            return this.constructor.scale(-1.0);
        }

        // Distance in radians from this point to point v2.
        distance(v2) {
            return Math.atan2(v2.crossLength(this), v2.dot(this));
        }

        // Returns in meters the minimum of the perpendicular distance of this point to the line
        // segment geo1-geo2 and the distance from this point to the line segment ends in geo1 and
        // geo2.
        distanceToLine(geo1, geo2) {
            // Point on unit sphere above origin and normal to plane of geo1,geo2 could be either
            // side of the plane.
            const p2 = geo1.crossNormalize(geo2);
            const d = geo1.distance(geo2);
            // Intersection of GC normal to geo1/geo2 passing through p with GC geo1/geo2.
            let ip = this.getIntersection(geo1, geo2, this, p2);
            let d1p = geo1.distance(ip);
            let d2p = geo2.distance(ip);
            // Need to check that ip or its antipode is between p1 and p2.
            if ((d >= d1p) && (d >= d2p)) {
                return this.radiansToMeters(this.distance(ip));
            } else {
                ip = ip.antipode();
                d1p = geo1.distance(ip);
                d2p = geo2.distance(ip);
            }
            if (d >= d1p && d >= d2p) {
                return this.radiansToMeters(this.distance(ip));
            } else {
                return this.radiansToMeters(Math.min(geo1.distance(this), geo2.distance(this)));
            }
        }

        *middleOutIter(data, start) {
            const len = data.length;
            let count = 0;
            let left = Math.max(0, Math.min(len, start == null ? Math.floor(len / 2) : start));
            let right = left;
            while (count++ < len) {
                let idx;
                if ((count % 2 && left > 0) || right === len) {
                    idx = --left;
                } else {
                    idx = right++;
                }
                yield [data[idx], idx];
            }
        }

        *hotColdIter(data, start) {
            const len = data.length;
            let count = 0;
            let left = Math.max(0, Math.min(len, start == null ? Math.floor(len / 2) : start));
            let right = left;
            let isHot;
            while (count++ < len) {
                let idx;
                if (isHot && right < len) {
                    idx = right++;
                } else if ((count % 2 && left > 0) || right === len) {
                    idx = --left;
                } else {
                    idx = right++;
                }
                isHot = yield [data[idx], idx];
            }
        }

        // Distance in meters from lat/lng point to polyline (array of lat/lng points).
        distanceToPolylineHotcold(polyline, options={}) {
            const min = options.min;
            let minDistance = Infinity;
            let offset;
            let isHot;
            const hotColdIter = this.hotColdIter(polyline, options.offsetHint);
            for (;;) {
                const x = hotColdIter.next(isHot);
                if (x.done) {
                    break;
                }
                const [[latA, lngA], i] = x.value;
                if (i === polyline.length - 1) {
                    continue;
                }
                const [latB, lngB] = polyline[i + 1];
                const d = this.distanceToLine(new BDCC(latA, lngA), new BDCC(latB, lngB));
                if (d < minDistance) {
                    minDistance = d;
                    isHot = true;
                    offset = i;
                    if (min !== undefined && d <= min) {
                        break;  // Allow caller to optimize when they only care if we are close.
                    }
                } else {
                    isHot = false;
                }
            }
            return [minDistance, offset];
        }

        // Distance in meters from lat/lng point to polyline (array of lat/lng points).
        distanceToPolylineMiddleout(polyline, options={}) {
            const min = options.min;
            let minDistance = Infinity;
            let offset;
            for (const [[latA, lngA], i] of this.middleOutIter(polyline, options.offsetHint)) {
                if (i === polyline.length - 1) {
                    continue;
                }
                const [latB, lngB] = polyline[i + 1];
                const d = this.distanceToLine(new BDCC(latA, lngA), new BDCC(latB, lngB));
                if (d < minDistance) {
                    minDistance = d;
                    offset = i;
                    if (min !== undefined && d <= min) {
                        break;  // Allow caller to optimize when they only care if we are close.
                    }
                }
            }
            return [minDistance, offset];
        }

        // Distance in meters from lat/lng point to polyline (array of lat/lng points).
        distanceToPolylineLinear(polyline, options={}) {
            const min = options.min;
            let minDistance = Infinity;
            for (let i = 0; i < polyline.length - 1; i++) {
                const [latA, lngA] = polyline[i];
                const [latB, lngB] = polyline[i + 1];
                const d = this.distanceToLine(new BDCC(latA, lngA), new BDCC(latB, lngB));
                if (d < minDistance) {
                    minDistance = d;
                }
                if (d <= min) {
                    break;  // Allow caller to optimize when they only care if we are close.
                }
            }
            return [minDistance, 0];
        }

        distanceToPolyline(polyline, options) {
            //return this.distanceToPolylineLinear(polyline, options);
            //return this.distanceToPolylineMiddleout(polyline, options);
            return this.distanceToPolylineHotcold(polyline, options);
        }
    }


    function createVAMStream(timeStream, altStream) {
        const vams = [0];
        for (let i = 1; i < timeStream.length; i++) {
            if (timeStream[i] === timeStream[i - 1]) {
                // Sadly this is possible and we just punt..
                // See https://www.strava.com/activities/5070815568 index 5218
                vams.push(0);
                continue;
            }
            const gain = Math.max(0, altStream[i] - altStream[i - 1]);
            vams.push((gain / (timeStream[i] - timeStream[i - 1])) * 3600);
        }
        return vams;
    }


    function altitudeChanges(stream) {
        let gain = 0;
        let loss = 0;
        if (stream && stream.length) {
            let last = stream[0];
            for (const x of stream) {
                if (x > last) {
                    gain += x - last;
                } else {
                    loss += last - x;
                }
                last = x;
            }
        }
        return {gain, loss};
    }


    return {
        distance,
        boundingBox,
        boundsOverlap,
        inBounds,
        BDCC,
        createVAMStream,
        altitudeChanges
    };
});


sauce.ns('perf', function() {
    'use strict';


    function calcTRIMP(duration, hrr, gender) {
        const y = hrr * (gender === 'female' ? 1.67 : 1.92);
        return (duration / 60) * hrr * 0.64 * Math.exp(y);
    }


    /* TRIMP based TSS, more accurate than hrTSS.
     * See: https://fellrnr.com/wiki/TRIMP
     */
    function tTSS(hrStream, timeStream, activeStream, ltHR, minHR, maxHR, gender) {
        let t = 0;
        let lastTime = timeStream[0];
        for (let i = 1; i < timeStream.length; i++) {
            if (!activeStream[i]) {
                lastTime = timeStream[i];
                continue;
            }
            const dur = timeStream[i] - lastTime;
            lastTime = timeStream[i];
            const hrr = (hrStream[i] - minHR) / (maxHR - minHR);
            t += calcTRIMP(dur, hrr, gender);
        }
        const tHourAtLT = calcTRIMP(3600, (ltHR - minHR) / (maxHR - minHR), gender);
        const tTSS = (t / tHourAtLT) * 100;
        return tTSS;
    }


    function estimateRestingHR(ftp) {
        // Use handwavy assumption that high FTP = low resting HR.
        const baselineW = 300;
        const baselineR = 50;
        const range = 20;
        const delta = ftp - baselineW;
        const diff = range * (delta / baselineW);
        return baselineR - diff;
    }


    function estimateMaxHR(zones) {
        // Estimate max from inner zone ranges.
        const avgRange = ((zones.z4 - zones.z3) + (zones.z3 - zones.z2)) / 2;
        return zones.z4 + avgRange;
    }


    // See:
    //  https://www.trainerroad.com/forum/t/tss-spreadsheets-with-atl-ctl-form/7613/10
    //  http://www.timetriallingforum.co.uk/index.php?/topic/74961-calculating-ctl-and-atl/#comment-1045764
    const chronicTrainingLoadConstant = 42;
    const acuteTrainingLoadConstant = 7;

    function _makeExpWeightedCalc(size) {
        const c = 1 - Math.exp(-1 / size);
        return function(data, seed=0) {
            let v = seed;
            for (const x of data) {
                v = (v * (1 - c)) + (x * c);
            }
            return v;
        };
    }

    const calcCTL = _makeExpWeightedCalc(chronicTrainingLoadConstant);
    const calcATL = _makeExpWeightedCalc(acuteTrainingLoadConstant);

    function expWeightedAvg(size, data, seed) {
        return _makeExpWeightedCalc(size)(data, seed);
    }

    function makeExpWeightedAccumulator(fixedSize, seed=0) {
        let v = seed;
        const fixedC = fixedSize ? 1 - Math.exp(-1 / fixedSize) : null;
        return function(x, size) {
            const c = size ? (1 - Math.exp(-1 / size)) : fixedC;
            v = (v * (1 - c)) + (x * c);
            return v;
        };
    }


    return {
        calcTRIMP,
        tTSS,
        estimateRestingHR,
        estimateMaxHR,
        calcCTL,
        calcATL,
        expWeightedAvg,
        makeExpWeightedAccumulator,
    };
});


sauce.ns('peaks', function() {
    'use strict';

    const metersPerMile = 1609.344;
    const defaults = {
        periods: [
            {value: 5},
            {value: 15},
            {value: 30},
            {value: 60},
            {value: 120},
            {value: 300},
            {value: 600},
            {value: 1200},
            {value: 1800},
            {value: 3600},
            {value: 10800},
        ],
        distances: [
            {value: 400},
            {value: 1000},
            {value: Math.round(metersPerMile)},
            {value: 3000},
            {value: 5000},
            {value: 10000},
            {value: Math.round(metersPerMile * 13.1), types: ['run', 'walk', 'hike']},
            {value: Math.round(metersPerMile * 26.2), types: ['run', 'walk', 'hike']},
            {value: 50000},
            {value: 100000},
            {value: Math.round(metersPerMile * 100)},
        ]
    };


    async function getRanges(type) {
        const custom = await sauce.storage.get('analysis_peak_ranges');
        return custom && custom[type] || defaults[type];
    }


    async function setRanges(type, data) {
        await sauce.storage.update('analysis_peak_ranges', {[type]: data});
    }


    async function resetRanges(type) {
        await sauce.storage.update('analysis_peak_ranges', {[type]: null});
    }


    async function getForActivityType(type, activityType) {
        const data = await getRanges(type);
        const t = activityType.toLowerCase();
        return data.filter(x => !x.types || x.types.includes(t));
    }


    async function isCustom(type) {
        return await getRanges(type) === defaults[type];
    }



    return {
        defaults,
        getForActivityType,
        getRanges,
        setRanges,
        resetRanges,
        isCustom,
    };
});