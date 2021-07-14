/**
 * TODO:
 *  - Add check for correct number / type of arguments.
 * 	- Can we tell whether a function throws via its metadata?
 */

import { Struct, Type } from "./types";
import { Value, Instance } from "./runtime";

type SwiftType = Type;

class TrampolinePool {
    private static pages: NativePointer[];
    private static currentSlot: NativePointer;

    private static get currentPage(): NativePointer {
        return TrampolinePool.pages[TrampolinePool.pages.length - 1];
    }

    private static _initialize() {
        TrampolinePool.pages = [Memory.alloc(Process.pageSize)];
        TrampolinePool.currentSlot = TrampolinePool.currentPage;
    }

    public static allocateTrampoline(size: number): NativePointer {
        if (TrampolinePool.pages === undefined) {
            TrampolinePool._initialize();
        }

        let currentPage = TrampolinePool.currentPage;
        const currentPageEnd = currentPage.add(Process.pageSize);

        if (TrampolinePool.currentSlot.add(size).compare(currentPageEnd) > 0) {
            currentPage = Memory.alloc(Process.pageSize);
            TrampolinePool.pages.push(currentPage);
        }

        const currentSlot = TrampolinePool.currentSlot;
        TrampolinePool.currentSlot = TrampolinePool.currentSlot.add(size);

        return currentSlot;
    }
}

export function SwiftNativeFunction(address: NativePointer, retType: SwiftType,
                                    argTypes: SwiftType[], context?: NativePointer,
                                    throws?: boolean) {
    let nativeRetType = makeCType(retType);
    const nativeArgTypes = argTypes.map(ty => makeCType(ty)).flat();
    const isLoadableResult = Array.isArray(nativeRetType) &&
                             nativeRetType.length > 1;
    let retSize: number;
    let indirectResult: NativePointer;

    if (retType.kind !== "Class" && nativeRetType === "pointer") {
        retSize = retType.metadata.getTypeLayout().stride;
        indirectResult = Memory.alloc(retSize);
        this.indirectResult = indirectResult;
    }

    if (isLoadableResult) {
        nativeRetType = "pointer";
    }

    const formattedArgs = `[${nativeArgTypes.map(a => `"${a}"`)}]`;
    const trampoline = jitSwiftcallTrampoline(address, nativeRetType,
                                              nativeArgTypes, context,
                                              indirectResult, throws)
    const nativeFunction = eval(`var f = new NativeFunction(ptr(${trampoline}),` +
                                `"${nativeRetType}",${formattedArgs}); f;`);
    const fnThis = this;

    if (isLoadableResult) {
        const tail = Interceptor.attach(trampoline, {
            onLeave(retval) {
                const struct = retType as Struct;
                const value = struct.makeFromContext(this.context);

                fnThis.value = value;

                retval.replace(value);
                tail.detach();
            }
        });
    }

    return function(...args: Value[]) {
        const acutalArgs: any[] = [];

        for (const arg of args) {
            const cObj = makeCObject(arg);
            if (Array.isArray(cObj)) {
                acutalArgs.push(...cObj);
            } else {
                acutalArgs.push(cObj);
            }
        }

        const retval = nativeFunction(...acutalArgs);

        if (indirectResult !== undefined) {
            return new Value(retType, ArrayBuffer.wrap(indirectResult, retSize));
        }

        if (isLoadableResult) {
            const valueType = retType as Struct;
            const value = valueType.makeFromRegion(retval);

            return value;
        }

        return retval;
    }
}

function makeCType(type: Type): NativeType {
    if (type.kind === "Class" ||
        shouldPassIndirectly(type)) {
        return "pointer";
    } else {
        const asStruct = type as Struct;
        /**TODO:
         * - Make it arch-agnostic
         * - Unsigned ints?
         */
        const sizeInQWords = asStruct.typeLayout.stride / 8;

        return sizeInQWords === 1 ? "uint64" : Array(sizeInQWords).fill("uint64");
    }
}

function makeCObject(object: Value): number | number[] | NativePointer {
    const type = object.type;

    if (shouldPassIndirectly(type)) {
        return object.handle;
    } else {
        const asStruct = type as Struct;
        const stride = asStruct.typeLayout.stride;
        const view = new DataView(object.buffer);
        const data: number[] = [];

        for (let i = 0; i < stride; i += 8) {
            const left = view.getUint32(i + 0);
            const right = view.getUint32(i + 4);
            const combined = (2**32 * left) + right;

            data.push(combined);
        }

        return data.length === 1 ? data[0] : data;
    }
}

function shouldPassIndirectly(type: Type) {
    const vwt = type.metadata.getValueWitnesses();
    return !vwt.flags.isBitwiseTakable || vwt.stride > 32;
}

function jitSwiftcallTrampoline(target: NativePointer, retType: NativeType,
                                argTypes: NativeType[], context?: NativePointer,
                                indirectResult?: NativePointer,
                                throws?: boolean): NativePointer {
    if (indirectResult !== undefined && retType !== "pointer") {
        throw new Error("Indirect results require a pointer");
    }

    /* This value is a heuristic */
    const maxPatchSize = 40 + argTypes.length * 32;
    const trampoline = TrampolinePool.allocateTrampoline(maxPatchSize);

    Memory.patchCode(trampoline, maxPatchSize, (code) => {
        const writer = new Arm64Writer(code, { pc: trampoline } );

        if (context !== undefined) {
            writer.putLdrRegAddress("x20", context);
        }

        if (!!throws) {
            writer.putAndRegRegImm("x21", "x21", 0);
        }

        if (indirectResult) {
            writer.putLdrRegAddress("x8", indirectResult);
        }

        writer.putBranchAddress(target);

        writer.flush();
    });;

    return trampoline;
}
