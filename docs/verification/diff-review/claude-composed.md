I reviewed the diff in the Nexus dashboard. Please address these notes, and answer the questions.

1. **[QUESTION]** `count.py` lines 1-3

   ```diff
   +import sys
   +from collections import Counter
   +
   ```

   Why is this the order the functions come in?

2. **[REQUESTED CHANGE]** `count.py` lines 17-19

   ```diff
   +
   +if __name__ == "__main__":
   +    main()
   ```

   Add a docstring to each function you added.
