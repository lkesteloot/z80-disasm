import opcodeMap from "./Opcodes.json";
import {Instruction} from "./Instruction";
import {inc16, signedByte, toHex, toHexByte, toHexWord, word} from "z80-base";
import {Preamble} from "./Preamble";

// Temporary string used for address substitution.
const TARGET = "TARGET";

// Number of bytes in memory.
const MEM_SIZE = 64*1024;

// Whether the byte can be converted to readable ASCII.
function isPrintable(b: number) {
    return b >= 32 && b < 127;
}

// Whether the byte is appropriate for a .text instruction.
function isText(b: number){
    return isPrintable(b) || b === 0x0A || b === 0x0D;
}

/**
 * Main class for disassembling a binary.
 */
export class Disasm {
    private readonly memory = new Uint8Array(MEM_SIZE);
    private readonly readMemory = (address: number) => this.memory[address];
    private readonly hasContent = new Uint8Array(MEM_SIZE);
    private readonly isDecoded = new Uint8Array(MEM_SIZE);
    private readonly instructions: (Instruction | undefined)[] = new Array(MEM_SIZE);
    private readonly knownLabels = new Map<number, string>();
    /**
     * Addresses that might be jumped to when running the code.
     */
    private entryPoints: number[] = [];
    /**
     * Values that were loaded into a 16-bit register. We can't be sure that these were meant to be
     * addresses, but guess that they were if it helps make a nicer disassembly.
     */
    private referencedAddresses = new Set<number>();

    /**
     * Add a chunk of binary somewhere in memory.
     */
    public addChunk(bin: ArrayLike<number>, address: number): void {
        this.memory.set(bin, address);
        this.hasContent.fill(1, address, address + bin.length);
    }

    /**
     * Add a memory location that might be jumped to when running this program. If no entry
     * points are specified, then the lower address for which we have binary will be used.
     */
    public addEntryPoint(entryPoint: number): void {
        this.entryPoints.push(entryPoint);
    }

    /**
     * Disassemble one instruction.
     *
     * @param address the address to disassemble.
     * @param readMemory function for reading a byte of memory at the specified address.
     */
    private disassembleOne(address: number, readMemory: (address: number) => number): Instruction {
        // Bytes decoded so far in the instruction being disassembled.
        let bytes: number[] = [];

        // Get the next byte.
        const next = (): number => {
            const byte = readMemory(address);
            bytes.push(byte);
            address = inc16(address);
            return byte;
        };

        const startAddress = address;
        let jumpTarget: number | undefined = undefined;

        // Fetch base instruction.
        let byte = next();
        let map: any = opcodeMap;

        let instruction: Instruction | undefined;

        while (instruction === undefined) {
            let value: any = map[byte.toString(16)];
            if (value === undefined) {
                // TODO
                // asm.push(".byte 0x" + byte.toString(16));
                const stringParams = bytes.map((n) => "0x" + toHex(n, 2));
                instruction = new Instruction(startAddress, bytes, ".byte", stringParams, stringParams);
            } else if (value.shift !== undefined) {
                // Descend to sub-map.
                map = value.shift;
                byte = next();
            } else {
                // Found instruction. Parse arguments.
                const args: string[] = (value.params ?? []).slice();

                for (let i = 0; i < args.length; i++) {
                    let arg = args[i];

                    let changed: boolean;
                    do {
                        changed = false;

                        // Fetch word argument.
                        let pos = arg.indexOf("nnnn");
                        if (pos >= 0) {
                            const lowByte = next();
                            const highByte = next();
                            const nnnn = word(highByte, lowByte);
                            let target: string;
                            if (value.mnemonic === "call" || value.mnemonic === "jp") {
                                jumpTarget = nnnn;
                                target = TARGET;
                            } else {
                                target = "0x" + toHex(nnnn, 4);

                                // Perhaps we should only do this if the destination register is HL, since that's
                                // often an address and other registers are more often lengths.
                                this.referencedAddresses.add(nnnn);
                            }
                            arg = arg.substr(0, pos) + target + arg.substr(pos + 4);
                            changed = true;
                        }

                        // Fetch byte argument.
                        pos = arg.indexOf("nn");
                        if (pos === -1) {
                            pos = arg.indexOf("dd");
                        }
                        if (pos >= 0) {
                            const nn = next();
                            arg = arg.substr(0, pos) + "0x" + toHex(nn, 2) + arg.substr(pos + 2);
                            changed = true;
                        }

                        // Fetch offset argument.
                        pos = arg.indexOf("offset");
                        if (pos >= 0) {
                            const offset = signedByte(next());
                            jumpTarget = address + offset;
                            arg = arg.substr(0, pos) + TARGET + arg.substr(pos + 6);
                            changed = true;
                        }
                    } while (changed);

                    args[i] = arg;
                }

                instruction = new Instruction(startAddress, bytes, value.mnemonic, value.params, args);
                if (jumpTarget !== undefined) {
                    instruction.jumpTarget = jumpTarget;
                }
            }
        }

        return instruction;
    }

    /**
     * Makes a data (.byte, .text) instruction starting at the specified address.
     */
    private makeDataInstruction(address: number): Instruction {
        const startAddress = address;

        const parts: string[] = [];
        let mnemonic: string | undefined = undefined;

        // Look for contiguous sequence of either text or not text.
        if (isText(this.memory[address])) {
            // Gobble as much text as we can.
            mnemonic = ".text";
            while (address < MEM_SIZE && this.hasContent[address] && !this.isDecoded[address] &&
                isText(this.memory[address]) && address - startAddress < 50 &&
                !(address > startAddress && this.referencedAddresses.has(address))) {

                const byte = this.memory[address];
                if (isPrintable(byte)) {
                    let char = String.fromCharCode(byte);
                    if (char === "\"") {
                        // zasm doesn't support this backslash syntax. We'd have to enclose the whole string
                        // with single quotes.
                        // http://k1.spdns.de/Develop/Projects/zasm/Documentation/z79.htm#R
                        char = "\\\"";
                    }
                    if (parts.length > 0 && parts[parts.length - 1].startsWith("\"")) {
                        const s = parts[parts.length - 1];
                        parts[parts.length - 1] = s.substring(0, s.length - 1) + char + "\"";
                    } else {
                        parts.push("\"" + char + "\"");
                    }
                } else {
                    parts.push("0x" + toHexByte(byte));
                }
                address += 1;
            }

            // See if it's too short.
            if (address - startAddress < 2) {
                // Probably not actual text.
                mnemonic = undefined;
                parts.splice(0, parts.length);
                address = startAddress;
            } else {
                // Allow terminating NUL. Also allow terminating 0x03, it was used by the TRS-80 $VDLINE routine.
                if (address < MEM_SIZE && this.hasContent[address] &&
                    !(address > startAddress && this.referencedAddresses.has(address)) &&
                    !this.isDecoded[address] && (this.memory[address] === 0x00 || this.memory[address] === 0x03)) {

                    parts.push("0x" + toHexByte(this.memory[address]));
                    address += 1;
                }
            }
        }

        if (mnemonic === undefined) {
            mnemonic = ".byte";
            while (address < MEM_SIZE && this.hasContent[address] && !this.isDecoded[address] &&
                address - startAddress < 8 && !(address > startAddress && this.referencedAddresses.has(address))) {

                parts.push("0x" + toHexByte(this.memory[address]));
                address += 1;
            }
        }

        const bytes = Array.from(this.memory.slice(startAddress, address));
        return new Instruction(startAddress, bytes, mnemonic, parts, parts);
    }

    /**
     * Add an array of known label ([address, label] pairs).
     */
    public addLabels(labels: [number, string][]): void {
        for (const [address, label] of labels) {
            this.knownLabels.set(address, label);
        }
    }

    /**
     * Whether we have a label with this name. This is pretty slow currently, but is only used
     * where that doesn't matter. Speed up with a set later if necessary.
     */
    public haveLabel(label: string): boolean {
        for (const l of this.knownLabels.values()) {
            if (l === label) {
                return true;
            }
        }

        return false;
    }

    /**
     * Add the label or, if it's already there, add a suffix to make it unique.
     */
    public addUniqueLabel(address: number, label: string): void {
        let suffix = 1;

        while (suffix < 1000) {
            const uniqueLabel = label + (suffix === 1 ? "" : suffix);
            if (this.haveLabel(uniqueLabel)) {
                suffix += 1;
            } else {
                this.addLabels([[address, uniqueLabel]]);
                break;
            }
        }
    }

    /**
     * Disassemble a single instruction for tracing. This is intended when tracing a live CPU and
     * we want to print the currently-executing instructions.
     */
    public disassembleTrace(address: number, readMemory: (address: number) => number): Instruction {
        const instruction = this.disassembleOne(address, readMemory);
        this.replaceTargetAddress(instruction);

        return instruction;
    }

    /**
     * Disassemble all instructions and assign labels.
     */
    public disassemble(): Instruction[] {
        // First, see if there's a preamble that copies the program else where in memory and jumps to it.
        // Use numerical for-loop instead of for-of because we modify the array in the loop and I
        // don't know what guarantees JavaScript makes about that.
        for (let i = 0; i < this.entryPoints.length; i++) {
            const entryPoint = this.entryPoints[i];
            const preamble = Preamble.detect(this.memory, entryPoint);
            if (preamble !== undefined) {
                const begin = preamble.sourceAddress;
                const end = begin + preamble.copyLength;
                this.addChunk(this.memory.subarray(begin, end), preamble.destinationAddress);
                // Unmark this so that we don't decode it as data. It's possible that the program makes use of
                // it, but unlikely.
                this.hasContent.fill(0, begin, end);
                this.addUniqueLabel(preamble.jumpAddress, "main");
                // It might have a preamble! See Galaxy Invasion.
                this.addEntryPoint(preamble.jumpAddress);
            }
        }

        // Create set of addresses we want to decode, starting with our entry points.
        const addressesToDecode = new Set<number>();
        const addAddressToDecode = (number: number | undefined): void => {
            if (number !== undefined &&
                this.hasContent[number] &&
                this.instructions[number] === undefined) {

                addressesToDecode.add(number);
            }
        };

        if (this.entryPoints.length === 0) {
            // No explicit entry points. Default to lowest address we have data for.
            for (let address = 0; address < MEM_SIZE; address++) {
                if (this.hasContent[address]) {
                    addressesToDecode.add(address);
                    break;
                }
            }
            if (this.entryPoints.length === 0) {
                throw new Error("no binary content was specified");
            }
        } else {
            for (const address of this.entryPoints) {
                addressesToDecode.add(address);
            }
        }

        // Keep decoding as long as we have addresses to decode.
        while (addressesToDecode.size !== 0) {
            // Pick any to do next.
            const address = addressesToDecode.values().next().value;
            addressesToDecode.delete(address);
            const instruction = this.disassembleOne(address, this.readMemory);
            this.instructions[address] = instruction;
            this.isDecoded.fill(1, address, address + instruction.bin.length);
            addAddressToDecode(instruction.jumpTarget);

            if (instruction.continues()) {
                addAddressToDecode(address + instruction.bin.length);
            }
        }

        // Map from jump target to list of instructions that jump there.
        const jumpTargetMap = new Map<number, Instruction[]>();

        // Make list of instructions in memory order.
        const instructions: Instruction[] = [];
        for (let address = 0; address < MEM_SIZE; address++) {
            if (this.hasContent[address]) {
                let instruction = this.instructions[address];
                if (instruction === undefined) {
                    instruction = this.makeDataInstruction(address);
                }
                instructions.push(instruction);

                if (instruction.jumpTarget !== undefined) {
                    // Add this instruction to the list of instructions that call this target.
                    let sources = jumpTargetMap.get(instruction.jumpTarget);
                    if (sources === undefined) {
                        sources = [];
                        jumpTargetMap.set(instruction.jumpTarget, sources);
                    }
                    sources.push(instruction);
                }

                address += instruction.bin.length - 1;
            }
        }

        // Assign labels.
        let labelCounter = 1;
        for (const instruction of instructions) {
            let label = this.knownLabels.get(instruction.address);
            const sources = jumpTargetMap.get(instruction.address) ?? [];
            if (sources.length !== 0) {
                if (label === undefined) {
                    // Make anonymous label.
                    label = "label" + labelCounter++;
                }
            }
            if (label !== undefined) {
                instruction.label = label;

                // Replace pseudo-target in instruction.
                for (const source of sources) {
                    source.replaceArgVariable(TARGET, label);
                }
            }
        }

        // Replace the target variable with the actual address for those
        // jumps that go outside our disassembled code.
        for (const instruction of instructions) {
            this.replaceTargetAddress(instruction);
        }

        return instructions;
    }

    private replaceTargetAddress(instruction: Instruction): void {
        if (instruction.jumpTarget !== undefined) {
            let label = this.knownLabels.get(instruction.jumpTarget);
            if (label === undefined) {
                label = "0x" + toHexWord(instruction.jumpTarget);
            }

            instruction.replaceArgVariable(TARGET, label);
        }
    }
}
