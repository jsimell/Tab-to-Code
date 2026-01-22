import { useState, useContext, useEffect, useRef } from "react";
import {
  Code,
  CodeId,
  Passage,
  PassageId,
  WorkflowContext,
} from "../../../appContext/WorkflowContext";
import { XMarkIcon } from "@heroicons/react/24/solid";

interface CodeBlobProps {
  codeId: CodeId;
  parentPassage: Passage;
  codeSuggestions: string[];
  autocompleteSuggestion: string | null;
  activeCodeId: CodeId | null;
  setActiveCodeId: React.Dispatch<React.SetStateAction<CodeId | null>>;
  setPendingHighlightFetches: React.Dispatch<React.SetStateAction<Array<PassageId>>>;
  preventCodeBlobDeactivationRef: React.RefObject<boolean>;
  isLastCodeOfPassage: boolean;
  codeManager: {
    updateCode: (cid: CodeId, newCodeValue: string) => PassageId | null;
    deleteCode: (id: CodeId) => PassageId | null;
    editAllInstancesOfCode: (oldValue: string, newValue: string) => void;
  };
  suggestionsManager: {
    updateAutocompleteSuggestionForPassage: (
      id: `passage-${number}`,
      existingCodes: string[],
      currentUserInput: string
    ) => Promise<void>;
    updateCodeSuggestionsForPassage: (id: `passage-${number}`, existingCodes: string[]) => Promise<void>;
  };
}

const CodeBlob = ({
  codeId,
  parentPassage,
  codeSuggestions,
  autocompleteSuggestion,
  activeCodeId,
  setActiveCodeId,
  setPendingHighlightFetches,
  preventCodeBlobDeactivationRef,
  isLastCodeOfPassage,
  codeManager,
  suggestionsManager,
}: CodeBlobProps) => {
  // Extract functions from the custom hooks passed via props
  const { updateAutocompleteSuggestionForPassage, updateCodeSuggestionsForPassage } =
    suggestionsManager;
  const { deleteCode, updateCode } = codeManager;

  // CONTEXT
  const context = useContext(WorkflowContext)!; // Non-null assertion since parent already ensures WorkflowContext is provided
  const { codes, codebook, passages, setPassages, aiSuggestionsEnabled } = context;

  // STATE
  const [ghostText, setGhostText] = useState<string>("Type code...");
  const codeObject = codes.find((c) => c.id === codeId);
  if (!codeObject) return null;
  const [inputValue, setInputValue] = useState(codeObject.code);

  // REFS
  const changeIndexRef = useRef<number>(inputValue.length); // Track index where last change occurred inside contentEditable
  const inputRef = useRef<HTMLSpanElement | null>(null);
  const previousValueRef = useRef<string>(inputValue);
  const previousPreSemicolonRef = useRef<string>(
    inputValue.lastIndexOf(";") === -1 ? "" : inputValue.slice(0, inputValue.lastIndexOf(";"))
  );
  const refreshAfterCursorRef = useRef<boolean>(false);
  const suppressGhostTextRef = useRef<boolean>(false);

  // EFFECTS
  // Active code blob should have focus
  useEffect(() => {
    if (activeCodeId === codeId && inputRef.current !== document.activeElement) {
      inputRef.current?.focus();
    }
  }, [activeCodeId]);

  // If the user edited codes before the last semicolon, we only refresh suggestions once the
  // cursor returns to after the last semicolon (so we don't spam refreshes while they're editing earlier codes).
  useEffect(() => {
    if (activeCodeId !== codeId) {
      refreshAfterCursorRef.current = false;
      suppressGhostTextRef.current = false;
    }
  }, [activeCodeId, codeId]);

  // Fetch new code suggestions and autocomplete suggestions for the parent passage when code blob is activated.
  // EXCEPTION: skip code suggestions fetch on first render, if the code blob was created through a highlight suggestion,
  // because in that case the initial code suggestions are already provided.
  useEffect(() => {
    if (!aiSuggestionsEnabled) return;
    if (!activeCodeId) return;
    if (activeCodeId === codeId) {
      // Only fetch suggestions if AI suggestions are enabled
      if (aiSuggestionsEnabled) {
        // Update suggestions for the parent passage
        const fetchSuggestions = async () => {
          // If the passage has only one empty code, but has code suggestions, the passage was created through a highlight suggestion
          // => in this case, skip the initial code suggestions fetch
          const codesOfPassage = codes
            .filter((c) => c.passageId === parentPassage.id)
            .map((c) => c.code);
          if (
            parentPassage.codeIds.length === 1 &&
            codesOfPassage[0] === "" &&
            parentPassage.codeSuggestions.length > 0
          ) {
            return;
          } else {
            // On subsequent renders, fetch both code suggestions normally
            await updateCodeSuggestionsForPassage(parentPassage.id, getExistingCodes());
          }
        };

        fetchSuggestions();
      }
    }
  }, [activeCodeId]);

  // Sync inputValue with global codes state when codes change (e.g., due to editAllInstancesOfCode)
  useEffect(() => {
    const updatedCodeObject = codes.find((c) => c.id === codeId);
    if (updatedCodeObject) {
      setInputValue(updatedCodeObject.code);
    }
  }, [codes]);

  // If the user inserts or removes a semicolon while actively editing this code blob,
  // clear the parent passage's code suggestions and immediately refresh them.
  useEffect(() => {
    const previousValue = previousValueRef.current;

    // Keep the ref in sync even when we early-return.
    const updatePrevious = () => {
      previousValueRef.current = inputValue;
    };

    if (!aiSuggestionsEnabled) {
      updatePrevious();
      return;
    }
    if (activeCodeId !== codeId) {
      updatePrevious();
      return;
    }
    // Only treat it as a user edit when the contentEditable is actually focused.
    if (inputRef.current !== document.activeElement) {
      updatePrevious();
      return;
    }
    if (previousValue === inputValue) {
      return;
    }

    const countSemicolons = (value: string) => (value.match(/;/g) ?? []).length;
    const previousSemicolons = countSemicolons(previousValue);
    const currentSemicolons = countSemicolons(inputValue);

    if (previousSemicolons !== currentSemicolons) {
      setPassages((prevPassages) =>
        prevPassages.map((p) => {
          if (p.id === parentPassage.id && p.isHighlighted) {
            return {
              ...p,
              codeSuggestions: [],
            };
          }
          return p;
        })
      );

      void updateCodeSuggestionsForPassage(parentPassage.id, getExistingCodes());
    }

    updatePrevious();
  }, [
    inputValue,
    aiSuggestionsEnabled,
    activeCodeId,
    codeId,
    parentPassage.id,
    setPassages,
    updateCodeSuggestionsForPassage,
  ]);

  // Update ghost text based on input value and suggestions
  useEffect(() => {
    // While the user is editing earlier (pre-last-semicolon) codes, hide ghost text entirely.
    if (activeCodeId === codeId && suppressGhostTextRef.current) {
      setGhostText("");
      return;
    }

    // If AI suggestions are disabled and input is empty, show default ghost text
    if (!aiSuggestionsEnabled && inputValue.length === 0) {
      setGhostText("Type code...");
      return;
    }

    const afterLastSemicolon = getAfterLastSemicolon(inputValue);
    // Ignore leading whitespace after ';' when matching (common pattern is '; ').
    // Keep trailing whitespace since it can be meaningful mid-code.
    const afterLastSemicolonStartTrimmed = afterLastSemicolon.trimStart();

    if (afterLastSemicolon.trim() === "") {
      // Nothing typed after last semicolon, or nothing typed at all
      // Find the first suggestion that hasn't been typed yet and isn't already an existing code of the passage,
      // and does not start with exactly the same text as an existing code of the passage (i.e. user likely shortened a suggestion)
      const existingCodes = getExistingCodes();
      const suggestion = codeSuggestions.find((s) => {
        const isNotInputted = !inputValue.includes(s);
        const isNotAnExistingCode = !existingCodes.includes(s);
        const doesNotStartWithExistingCode = !existingCodes.some(code => s.startsWith(code));
        return isNotInputted && isNotAnExistingCode && doesNotStartWithExistingCode;
      });
      if (suggestion && aiSuggestionsEnabled) {
        setGhostText(suggestion);
      } else {
        inputValue === "" ? setGhostText("Type code...") : setGhostText("");
      }
    } else {
      // There is some text after the last semicolon, or the user has typed part of the first code
      // First try to match with existing codebook codes
      let matchingSuggestion = Array.from(codebook).find(
        (code) =>
          code.toLowerCase().startsWith(afterLastSemicolonStartTrimmed.toLowerCase()) &&
          !inputValue.trim().includes(code.trim())
      );
      // If aiSuggestions are enabled, replace a possible codebook match with codeSuggestions or autocompleteSuggestion match if there is one
      if (aiSuggestionsEnabled) {
        // Replace matchingSuggestion if a match is found in codeSuggestions or autocompleteSuggestion
        // Autocomplete suggestion has priority over codeSuggestions => place it first
        const suggestionsArray = Array.from(
          new Set([
            ...(autocompleteSuggestion && autocompleteSuggestion.trim().length > 0 ? [autocompleteSuggestion] : []),
            ...codeSuggestions
          ])
        );
        const suggestionMatch = suggestionsArray.find(
          (suggestion) =>
            suggestion.toLowerCase().startsWith(afterLastSemicolonStartTrimmed.toLowerCase()) &&
            !inputValue.toLowerCase().includes(suggestion.toLowerCase().trim())
        );
        if (suggestionMatch) {
          matchingSuggestion = suggestionMatch;
        }
      }

      // Set ghost text based on the matching suggestion
      const inputLastCharIsSpace = inputValue.slice(-1) === " ";
      setGhostText(
        inputLastCharIsSpace
          ? matchingSuggestion?.slice(afterLastSemicolonStartTrimmed.length).trim() || ""
          : matchingSuggestion?.slice(afterLastSemicolonStartTrimmed.length) || ""
      );
    }
  }, [
    activeCodeId,
    inputValue,
    codeSuggestions,
    autocompleteSuggestion,
    aiSuggestionsEnabled,
  ]);

  // Fetch a new autocomplete suggestion after user stops typing for 1.5s
  useEffect(() => {
    if (!aiSuggestionsEnabled) return;
    if (activeCodeId !== codeId) return;

    const afterLastSemicolon = getAfterLastSemicolon(inputValue);
    // If nothing typed after last semicolon, there is nothing to complete, so do not fetch autocomplete suggestion
    if (afterLastSemicolon.trim().length === 0) return;
    // If the current content of the input field matches an existing code exactly, this means user has reactivated
    // a previously entered code and has not typed anything new yet -> do not fetch autocomplete suggestion
    if (
      codes.some((c) => c.passageId === parentPassage.id && c.code === inputValue.trim())
    ) {
      return;
    }
    // If there is already a visible ghost text, meaning that there is a
    // code suggestion or codebook match, or input is empty with "Type code..." shown,
    // do NOT fetch autocompleteSuggestion.
    if (ghostText) return;

    const existingCodes = getExistingCodes();

    // Code being typed (after last semicolon)
    const currentUserInput = afterLastSemicolon.trim();

    const timeoutId = window.setTimeout(() => {
      updateAutocompleteSuggestionForPassage(
        parentPassage.id,
        existingCodes,
        currentUserInput
      );
    }, 1500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [inputValue, activeCodeId, codeId, codes, aiSuggestionsEnabled, parentPassage.id]);

  // Ensure correct cursor position after input value changes
  useEffect(() => {
    const changeIndex = changeIndexRef.current;
    if (activeCodeId === codeId && inputRef.current) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(inputRef.current?.childNodes[0] || inputRef.current, changeIndex);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [inputValue]);

  // Ensure code input is defocused when activeCodeId changes to another code or null
  useEffect(() => {
    if (activeCodeId !== codeId) {
      inputRef.current?.blur();
    }
  }, [activeCodeId, codeId]);

  /**
   * A helper function to get the substring after the last semicolon in a string,
   * or the entire string if no semicolon is present. Not trimmed.
   * @param value the string to extract from
   * @returns the substring after the last semicolon, trimmed of whitespace
   */
  const getAfterLastSemicolon = (value: string) =>
    value.slice(value.lastIndexOf(";") + 1);

  /**
   * Get the set of existing codes for the parent passage, combining entered codes and the codes
   * present in this code blob before the last semicolon in the provided value.
   * @param value - the current value from which to extract codes before the last semicolon
   */
  const getExistingCodesForValue = (value: string) => {
    const enteredCodes = codes
      .filter((c) => c.passageId === parentPassage.id && c.id !== codeId)
      .map((c) => c.code);

    const semicolonIndex = value.lastIndexOf(";");
    const precedingCodes =
      semicolonIndex === -1
        ? []
        : value
            .slice(0, semicolonIndex)
            .split(";")
            .map((c) => c.trim())
            .filter((c) => c.length > 0);

    return Array.from(new Set([...enteredCodes, ...precedingCodes]));
  };

  /**
   * Get the set of existing codes for the parent passage, combining entered codes and the codes inputted in this code blob before the last semicolon.
   * @returns an array of existing codes as strings
   */
  const getExistingCodes = () => {
    return getExistingCodesForValue(inputValue);
  };

  const getCaretIndexInInput = (el: HTMLSpanElement): number | null => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range) return null;

    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(el);
    preCaretRange.setEnd(range.endContainer, range.endOffset);
    return preCaretRange.toString().length;
  };

  const clearAndRefreshCodeSuggestions = (valueOverride?: string) => {
    const effectiveValue = valueOverride ?? inputRef.current?.textContent ?? inputValue;

    setPassages((prevPassages) =>
      prevPassages.map((p) => {
        if (p.id === parentPassage.id && p.isHighlighted) {
          return {
            ...p,
            codeSuggestions: [],
          };
        }
        return p;
      })
    );

    void updateCodeSuggestionsForPassage(
      parentPassage.id,
      getExistingCodesForValue(effectiveValue)
    );
  };

  /**
   * Checks whether the cursor has moved past the last semicolon, and if so, refreshes code suggestions.
   */
  const maybeRefreshAfterCursorMovesPastLastSemicolon = () => {
    if (!aiSuggestionsEnabled) return;
    if (activeCodeId !== codeId) return;
    if (inputRef.current !== document.activeElement) return;
    if (!refreshAfterCursorRef.current) return;
    if (!inputRef.current) return;

    const currentValue = inputRef.current.textContent ?? inputValue;
    const lastSemicolonIndex = currentValue.lastIndexOf(";");
    if (lastSemicolonIndex === -1) return;

    const caretIndex = getCaretIndexInInput(inputRef.current);
    if (caretIndex === null) return;

    if (caretIndex > lastSemicolonIndex) {
      refreshAfterCursorRef.current = false;
      suppressGhostTextRef.current = false;
      clearAndRefreshCodeSuggestions(currentValue);
    }
  };

  /**
   * Handles input changes in the contentEditable element.
   * @param e - the input event that triggered the function call
   */
  const handleInputChange = (e: React.FormEvent<HTMLSpanElement>) => {
    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);

    if (range) {
      // Get cursor position relative to the contentEditable element
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(e.currentTarget);
      preCaretRange.setEnd(range.endContainer, range.endOffset);
      changeIndexRef.current = preCaretRange.toString().length;

      // Update input value state
      const nextValue = e.currentTarget.textContent || "";

      // If the user edited content before the last semicolon, mark that we need to refresh suggestions,
      // but do so only once they move the cursor back to after the last semicolon.
      const lastSemicolonIndex = nextValue.lastIndexOf(";");
      if (lastSemicolonIndex !== -1 && changeIndexRef.current <= lastSemicolonIndex) {
        suppressGhostTextRef.current = true;
        setGhostText("");

        const preLastSemicolon = nextValue.slice(0, lastSemicolonIndex);
        if (preLastSemicolon !== previousPreSemicolonRef.current) {
          previousPreSemicolonRef.current = preLastSemicolon;
          refreshAfterCursorRef.current = true;
        }
      } else {
        suppressGhostTextRef.current = false;
      }

      setInputValue(nextValue);
    }
  };

  /**
   * Handles a keyboard event that occurs during code editing.
   * @param e - the keyboard event that triggered the function call
   */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (activeCodeId === null) return;
    if (!e.currentTarget) return;

    // ENTER: finalize editing of the current code
    if (e.key === "Enter") {
      e.preventDefault();
      preventCodeBlobDeactivationRef.current = false;
      inputRef.current?.blur(); // Blur to trigger handleCodeEnter
      return;
    }

    // TAB: accept code suggestion (if any)
    if (e.key === "Tab") {
      e.preventDefault();
      if (ghostText && ghostText !== "Type code...") {
        setInputValue(inputValue + ghostText + "; ");
        setGhostText(""); // Clear ghost text after accepting
        setTimeout(moveInputCursorToEnd, 0); // Move cursor to end after DOM update
        return;
      }
    }

    // ESCAPE: decline ghost text suggestion (if any) and keep editing, OR finalize editing if no suggestion
    if (e.key === "Escape") {
      if (ghostText && ghostText !== "Type code...") {
        e.preventDefault();
        const suggestion = (getAfterLastSemicolon(inputValue) + ghostText).trim();
        // Remove the suggested text from the passage's code suggestions, if it exists there, and clear autocomplete suggestion
        const passage = passages.find((p) => p.id === parentPassage.id);
        if (!passage) return;
        setPassages((prevPassages) =>
          prevPassages.map((p) => {
            if (p.id === passage.id && p.isHighlighted) {
              return {
                ...p,
                codeSuggestions: p.codeSuggestions.filter((s) => s !== suggestion),
                autocompleteSuggestion: "",
              };
            }
            return p;
          })
        );
        setGhostText(""); // Clear ghost text
        return;
      } else {
        e.preventDefault();
        inputRef.current?.blur(); // Blur to trigger handleCodeEnter
        return;
      }
    }

    // DELETE: delete the current code
    if (e.key === "Delete") {
      e.preventDefault();
      handleDeletion();
      return;
    }
  };

  /** Handles the deletion of a code, which may trigger highlight suggestion fetches.
   *
   * @param codeId - the ID of the code to be deleted
   */
  const handleDeletion = () => {
    const queueForSuggestionFetch =
      (passages.find((p) => p.id === parentPassage.id)?.codeIds.length ?? 0) <= 1;
    const affectedPassageId = deleteCode(codeId);
    if (affectedPassageId && queueForSuggestionFetch) {
      setPendingHighlightFetches((prev) => [...prev, affectedPassageId]);
    }
  };

  /** Updates the code into the global state. */
  const handleCodeEnter = async () => {
    if (activeCodeId === null) return; // For safety: should not happen
    if (preventCodeBlobDeactivationRef.current) {
      // If code enter was caused by user clicking something that should not deactivate the code blob,
      // refocus the code blob instead of updating the code, and move cursor to end.
      inputRef.current?.focus();
      moveInputCursorToEnd();
      return;
    }
    preventCodeBlobDeactivationRef.current = false;

    const codeObject: Code | undefined = codes.find((c) => c.id === activeCodeId);
    if (!codeObject) return;

    const cleanedInputValue = inputValue.trim().replace(/;+$/, ""); // Remove trailing semicolons

    if (cleanedInputValue === "") {
      // If user entered an empty code, delete it
      handleDeletion();
      return;
    }

    setInputValue(cleanedInputValue);

    // Only update codes if the value actually changed
    if (cleanedInputValue !== codeObject.code) {
      const affectedPassageId = updateCode(activeCodeId, cleanedInputValue);
      setTimeout(() => {
        if (affectedPassageId) {
          setPendingHighlightFetches((prev) => [...prev, affectedPassageId]);
        }
      }, 0);
    }

    setActiveCodeId(null); // Set activeCodeId to null at the end

    return;
  };

  /**
   * Moves the input cursor to the end of the contentEditable element
   */
  const moveInputCursorToEnd = () => {
    if (!inputRef.current) return;
    const range = document.createRange();
    const selection = window.getSelection();
    range.selectNodeContents(inputRef.current);
    range.collapse(false); // false = collapse to end
    selection?.removeAllRanges();
    selection?.addRange(range);
    changeIndexRef.current = inputValue.length; // Update the change index ref
  };

  return (
    <>
      <span
        className={`
          inline-flex items-center self-center w-fit pl-2 pr-1.5 mr-1 my-0.5
        bg-tertiaryContainer border-1 border-gray-400 rounded-full hover:bg-tertiaryContainerHover 
          ${
            activeCodeId === codeId
              ? "bg-tertiaryContainerHover outline-1 border border-onBackground outline-onBackground shadow-[0_0_0_2px_black]"
              : ""
          } 
        `}
        onClick={() => setActiveCodeId(codeId)}
      >
        <div className="inline whitespace-pre-wrap">
          <span
            ref={inputRef}
            contentEditable={true}
            suppressContentEditableWarning={true}
            onInput={handleInputChange}
            onFocus={() => setActiveCodeId(codeId)}
            onBlur={handleCodeEnter} // blurring is essentially same as pressing enter
            onKeyDown={(e) => handleKeyDown(e)}
            onKeyUp={() => {
              maybeRefreshAfterCursorMovesPastLastSemicolon();
            }}
            onMouseUp={() => {
              maybeRefreshAfterCursorMovesPastLastSemicolon();
            }}
            className="bg-transparent outline-none whitespace-pre-wrap empty:before:content-['\200B']"
          >
            {inputValue}
          </span>
          {activeCodeId === codeId && (
            <span
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent blur event on contentEditable element
              }}
              onClick={() => {
                // Focus the contentEditable element when ghost text is clicked
                inputRef.current?.focus();
                moveInputCursorToEnd();
              }}
              className="text-gray-500"
            >
              {ghostText}
            </span>
          )}
        </div>
        <button
          type="button"
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent input from losing focus
          }}
          onClick={(e) => {
            e.stopPropagation();
            handleDeletion();
          }}
          className={`bg-transparent ml-1.5 rounded-full hover:text-gray-800 hover:bg-onBackground/10 cursor-pointer
            ${activeCodeId === codeId ? "text-gray-700" : "text-gray-600"}`}
        >
          <XMarkIcon className="size-5" />
        </button>
      </span>
      {
        isLastCodeOfPassage && parentPassage.text.endsWith("\n") && (
          <br />
        ) /* Preserve trailing newlines after code blobs */
      }
    </>
  );
};

export default CodeBlob;
